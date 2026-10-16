import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { Op, QueryTypes, UniqueConstraintError, col, fn, where as sequelizeWhere } from 'sequelize';
import {
  AssignShiftEmployeesDto,
  CreateShiftDto,
  EmployeeStatus,
  GetShiftsQueryDto,
  SHIFT_WEEKDAYS,
  ShiftStatusFilter,
  TenantErrorCode,
  TenantException,
  UpdateShiftDto,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { DataScopeService } from './data-scope.service';

const DAY_MINUTES = 24 * 60;
/** Who counts as "on" a shift: people still employed. */
const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];
const NAME_MAX = 100;

export interface ShiftRow {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  /** MONDAY … SUNDAY, in week order. */
  workingDays: string[];
  isActive: boolean;
  /** The shift ends the next day (a night shift). */
  crossesMidnight: boolean;
  /** Start to end, break included. */
  durationMinutes: number;
  /** Duration less the break. */
  workingMinutes: number;
  /** People still employed who are on this shift. */
  employeeCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const toMinutes = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

/** Start to end in minutes, wrapping past midnight when the end is earlier. */
const spanMinutes = (startTime: string, endTime: string) => {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  return end > start ? end - start : end + DAY_MINUTES - start;
};

const weekOrder = (days: string[]) => [...days].sort((a, b) => SHIFT_WEEKDAYS.indexOf(a as any) - SHIFT_WEEKDAYS.indexOf(b as any));

/**
 * Attendance → Shifts: the shifts an organization defines and who works them.
 *
 * Deliberately separate from `WorkingHours`, the one organization-wide
 * schedule attendance (late/early, working days) is judged against today.
 * Defining a shift or putting someone on it records the roster; it does not
 * change how their attendance is calculated.
 */
@Injectable()
export class ShiftService {
  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly dataScope?: DataScopeService,
  ) {}

  // ==========================================
  // Errors
  // ==========================================

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private notFound(shiftId: string): never {
    this.fail(HttpStatus.NOT_FOUND, `Shift '${shiftId}' not found in this organization.`);
  }

  private nameTaken(name: string): never {
    this.fail(HttpStatus.CONFLICT, `A shift named '${name}' already exists in this organization.`);
  }

  // ==========================================
  // Helpers
  // ==========================================

  /** Times and break have to describe a real working period. */
  private assertSchedule(startTime: string, endTime: string, breakMinutes: number) {
    if (startTime === endTime) this.fail(HttpStatus.BAD_REQUEST, 'The shift cannot start and end at the same time.');
    if (breakMinutes >= spanMinutes(startTime, endTime)) {
      this.fail(HttpStatus.BAD_REQUEST, 'The break must be shorter than the shift.');
    }
  }

  /** Shifts are few; counting how many people each has is one grouped query for all of them. */
  private async employeeCounts(tenantId: string): Promise<Map<string, number>> {
    const EmployeeShift = await this.modelProvider.getEmployeeShiftModel(tenantId);
    const rows = (await EmployeeShift.sequelize!.query(
      `SELECT es."shiftId" AS "shiftId", COUNT(*)::int AS "count"
         FROM employee_shifts es
         JOIN employees e ON e.id = es."employeeId"
        WHERE es."tenantId" = :tenantId AND e.status IN (:statuses)
        GROUP BY es."shiftId"`,
      { replacements: { tenantId, statuses: EMPLOYED }, type: QueryTypes.SELECT },
    )) as { shiftId: string; count: number }[];
    return new Map(rows.map((row) => [row.shiftId, Number(row.count)]));
  }

  private toRow(shift: any, employeeCount: number): ShiftRow {
    const duration = spanMinutes(shift.startTime, shift.endTime);
    const breakMinutes = Number(shift.breakMinutes ?? 0);
    return {
      id: shift.id,
      name: shift.name,
      startTime: shift.startTime,
      endTime: shift.endTime,
      breakMinutes,
      workingDays: weekOrder(shift.workingDays ?? []),
      isActive: shift.isActive !== false,
      crossesMidnight: toMinutes(shift.endTime) <= toMinutes(shift.startTime),
      durationMinutes: duration,
      workingMinutes: Math.max(0, duration - breakMinutes),
      employeeCount,
      createdAt: shift.createdAt,
      updatedAt: shift.updatedAt,
    };
  }

  private async load(tenantId: string, shiftId: string) {
    const Shift = await this.modelProvider.getShiftModel(tenantId);
    const shift = await Shift.findOne({ where: { id: shiftId, tenantId } });
    if (!shift) this.notFound(shiftId);
    return shift;
  }

  /** Names are unique regardless of case: "Night" and "night" would read as the same shift. */
  private async assertNameFree(tenantId: string, name: string, exceptId?: string) {
    const Shift = await this.modelProvider.getShiftModel(tenantId);
    const clash = await Shift.findOne({
      where: {
        tenantId,
        [Op.and]: [sequelizeWhere(fn('lower', col('name')), name.toLowerCase())],
        ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}),
      },
      attributes: ['id'],
    });
    if (clash) this.nameTaken(name);
  }

  /** The unique index is the last word when two requests race past the check above. */
  private rethrowDuplicate(error: unknown, name: string): never {
    if (error instanceof UniqueConstraintError) this.nameTaken(name);
    throw error;
  }

  // ==========================================
  // Reads
  // ==========================================

  async getAll(tenantId: string, query: GetShiftsQueryDto = {}) {
    const Shift = await this.modelProvider.getShiftModel(tenantId);
    const [shifts, counts] = await Promise.all([
      Shift.findAll({ where: { tenantId }, order: [['name', 'ASC']] }),
      this.employeeCounts(tenantId),
    ]);

    const rows = (shifts as any[]).map((shift) => this.toRow(shift, counts.get(shift.id) ?? 0));
    const term = query.search?.trim().toLowerCase();
    const status = query.status ?? ShiftStatusFilter.ALL;

    return {
      data: rows.filter(
        (row) =>
          (status === ShiftStatusFilter.ALL || row.isActive === (status === ShiftStatusFilter.ACTIVE)) &&
          (!term || row.name.toLowerCase().includes(term)),
      ),
      // Over every shift, whatever the filter — the figures in the page header.
      summary: {
        total: rows.length,
        active: rows.filter((row) => row.isActive).length,
        inactive: rows.filter((row) => !row.isActive).length,
        assignedEmployees: rows.reduce((total, row) => total + row.employeeCount, 0),
      },
    };
  }

  async getOne(tenantId: string, shiftId: string): Promise<ShiftRow> {
    const shift = await this.load(tenantId, shiftId);
    const counts = await this.employeeCounts(tenantId);
    return this.toRow(shift, counts.get(shift.id) ?? 0);
  }

  /** The people on a shift, by name. */
  async getEmployees(tenantId: string, shiftId: string) {
    await this.load(tenantId, shiftId);
    const EmployeeShift = await this.modelProvider.getEmployeeShiftModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);

    const rows = await EmployeeShift.findAll({
      where: { tenantId, shiftId },
      include: [
        {
          model: Employee,
          as: 'employee',
          required: true,
          where: { status: { [Op.in]: EMPLOYED } },
          attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'email', 'avatarUrl'],
          include: [{ model: Department, as: 'department', attributes: ['id', 'name'], required: false }],
        },
      ],
      order: [[{ model: Employee, as: 'employee' }, 'firstName', 'ASC'], [{ model: Employee, as: 'employee' }, 'lastName', 'ASC']],
    });

    const data = (rows as any[]).map((row) => ({
      id: row.employee.id,
      employeeCode: row.employee.employeeCode,
      name: [row.employee.firstName, row.employee.lastName].filter(Boolean).join(' '),
      email: row.employee.email ?? null,
      avatarUrl: row.employee.avatarUrl ?? null,
      department: row.employee.department ? { id: row.employee.department.id, name: row.employee.department.name } : null,
    }));
    return { data, total: data.length };
  }

  // ==========================================
  // Writes
  // ==========================================

  async create(tenantId: string, dto: CreateShiftDto): Promise<ShiftRow> {
    const name = dto.name.trim();
    const breakMinutes = dto.breakMinutes ?? 60;
    this.assertSchedule(dto.startTime, dto.endTime, breakMinutes);
    await this.assertNameFree(tenantId, name);

    const Shift = await this.modelProvider.getShiftModel(tenantId);
    try {
      const created = await Shift.create({
        tenantId,
        name,
        startTime: dto.startTime,
        endTime: dto.endTime,
        breakMinutes,
        workingDays: weekOrder(dto.workingDays),
        isActive: dto.isActive ?? true,
      });
      return this.toRow(created, 0);
    } catch (error) {
      return this.rethrowDuplicate(error, name);
    }
  }

  async update(tenantId: string, shiftId: string, dto: UpdateShiftDto): Promise<ShiftRow> {
    const shift = await this.load(tenantId, shiftId);

    const next = {
      name: dto.name?.trim() ?? shift.name,
      startTime: dto.startTime ?? shift.startTime,
      endTime: dto.endTime ?? shift.endTime,
      breakMinutes: dto.breakMinutes ?? Number(shift.breakMinutes ?? 0),
    };
    this.assertSchedule(next.startTime, next.endTime, next.breakMinutes);
    if (next.name.toLowerCase() !== String(shift.name).toLowerCase()) {
      await this.assertNameFree(tenantId, next.name, shiftId);
    }

    try {
      await shift.update({
        ...next,
        ...(dto.workingDays ? { workingDays: weekOrder(dto.workingDays) } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      });
    } catch (error) {
      return this.rethrowDuplicate(error, next.name);
    }
    const counts = await this.employeeCounts(tenantId);
    return this.toRow(shift, counts.get(shift.id) ?? 0);
  }

  /** A copy under a free name ("Night Shift Copy", "Night Shift Copy 2"…) with nobody on it. */
  async duplicate(tenantId: string, shiftId: string): Promise<ShiftRow> {
    const source = await this.load(tenantId, shiftId);
    const Shift = await this.modelProvider.getShiftModel(tenantId);
    const taken = new Set(
      ((await Shift.findAll({ where: { tenantId }, attributes: ['name'] })) as any[]).map((row) => String(row.name).toLowerCase()),
    );

    let name = '';
    for (let copy = 1; copy < 1000; copy += 1) {
      const suffix = copy === 1 ? ' Copy' : ` Copy ${copy}`;
      // The suffix has to fit inside the name limit, so a long name gives way to it.
      const candidate = `${String(source.name).slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
      if (!taken.has(candidate.toLowerCase())) {
        name = candidate;
        break;
      }
    }
    if (!name) this.fail(HttpStatus.CONFLICT, 'Too many copies of this shift already exist. Rename one first.');

    try {
      const created = await Shift.create({
        tenantId,
        name,
        startTime: source.startTime,
        endTime: source.endTime,
        breakMinutes: source.breakMinutes,
        workingDays: source.workingDays,
        isActive: source.isActive,
      });
      return this.toRow(created, 0);
    } catch (error) {
      return this.rethrowDuplicate(error, name);
    }
  }

  /**
   * Returns a body rather than void: an RPC handler that resolves to
   * undefined completes the client observable without emitting, which the
   * gateway surfaces as an EmptyError even though the row is gone.
   */
  async remove(tenantId: string, shiftId: string) {
    const shift = await this.load(tenantId, shiftId);
    const EmployeeShift = await this.modelProvider.getEmployeeShiftModel(tenantId);
    // Every assignment row, not just the employed ones: the row is what blocks the delete.
    const assigned = await EmployeeShift.count({ where: { tenantId, shiftId } });
    if (assigned > 0) {
      this.fail(
        HttpStatus.CONFLICT,
        `Shift '${shift.name}' has ${assigned} employee${assigned === 1 ? '' : 's'} on it and cannot be deleted. Move them to another shift first, or deactivate it instead.`,
      );
    }
    await shift.destroy();
    return { deleted: true, id: shiftId };
  }

  /**
   * Sets exactly who works this shift. Anyone listed is moved here from
   * whatever shift they were on; anyone on it but not listed is taken off.
   * All in one transaction, so a failure never leaves half a roster.
   */
  async setEmployees(tenantId: string, shiftId: string, dto: AssignShiftEmployeesDto): Promise<ShiftRow> {
    const shift = await this.load(tenantId, shiftId);
    const ids = [...new Set(dto.employeeIds)];
    const EmployeeShift = await this.modelProvider.getEmployeeShiftModel(tenantId);

    if (ids.length) {
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const scope = this.dataScope ? await this.dataScope.employeeWhere(tenantId, 'id') : {};
      const found = (await Employee.findAll({
        where: { tenantId, id: { [Op.in]: ids }, ...scope },
        attributes: ['id', 'firstName', 'lastName', 'status'],
      })) as any[];

      // An id outside the organization — or outside the caller's scope — doesn't exist for them.
      if (found.length !== ids.length) {
        const known = new Set(found.map((employee) => employee.id));
        this.fail(
          HttpStatus.NOT_FOUND,
          `${ids.filter((id) => !known.has(id)).length} of the selected employees were not found in this organization.`,
        );
      }
      const gone = found.filter((employee) => !EMPLOYED.includes(employee.status));
      if (gone.length) {
        this.fail(
          HttpStatus.BAD_REQUEST,
          `Only current employees can be put on a shift. Not currently employed: ${gone
            .map((employee) => [employee.firstName, employee.lastName].filter(Boolean).join(' '))
            .join(', ')}.`,
        );
      }

      const alreadyHere = new Set(
        ((await EmployeeShift.findAll({ where: { tenantId, shiftId, employeeId: { [Op.in]: ids } }, attributes: ['employeeId'] })) as any[]).map(
          (row) => row.employeeId,
        ),
      );
      if (!shift.isActive && ids.some((id) => !alreadyHere.has(id))) {
        this.fail(HttpStatus.CONFLICT, `Shift '${shift.name}' is inactive. Activate it before putting more employees on it.`);
      }
    }

    await EmployeeShift.sequelize!.transaction(async (transaction) => {
      // Off this shift: everyone not listed.
      await EmployeeShift.destroy({
        where: { tenantId, shiftId, ...(ids.length ? { employeeId: { [Op.notIn]: ids } } : {}) },
        transaction,
      });
      if (!ids.length) return;

      // Off their old shift (an employee has one), then onto this one.
      await EmployeeShift.destroy({
        where: { tenantId, employeeId: { [Op.in]: ids }, shiftId: { [Op.ne]: shiftId } },
        transaction,
      });
      const here = new Set(
        ((await EmployeeShift.findAll({ where: { tenantId, shiftId }, attributes: ['employeeId'], transaction })) as any[]).map(
          (row) => row.employeeId,
        ),
      );
      const missing = ids.filter((id) => !here.has(id));
      if (missing.length) {
        await EmployeeShift.bulkCreate(
          missing.map((employeeId) => ({ tenantId, shiftId, employeeId })),
          { transaction },
        );
      }
    });

    const counts = await this.employeeCounts(tenantId);
    return this.toRow(shift, counts.get(shift.id) ?? 0);
  }
}
