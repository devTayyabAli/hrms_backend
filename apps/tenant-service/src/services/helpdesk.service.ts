import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  AddTicketCommentDto,
  CreateMyTicketDto,
  EmployeeNotificationKind,
  EmployeeStatus,
  GetTicketsQueryDto,
  HelpdeskCategory,
  HelpdeskPriority,
  HelpdeskStatus,
  TenantErrorCode,
  TenantException,
  UpdateTicketDto,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { PermissionHoldersService } from './permission-holders.service';
import type { HelpdeskComment } from '../models/helpdesk-ticket.model';

const MAX_COMMENTS = 200;
const OPEN_STATUSES = [HelpdeskStatus.OPEN, HelpdeskStatus.IN_PROGRESS, HelpdeskStatus.WAITING_ON_REQUESTER];

const nameOf = (row?: { firstName?: string | null; lastName?: string | null } | null) => (row ? [row.firstName, row.lastName].filter(Boolean).join(' ') : '');

/**
 * The IT helpdesk. An employee raises a ticket and follows it; IT, who hold
 * the Tickets permissions, work a queue: take a ticket, change its priority,
 * answer, resolve. Who may do what is decided at the gateway (`tickets.view`
 * to read the queue, `tickets.manage` to work it); the "my" methods are the
 * employee's own and never take an employee id from the caller.
 */
@Injectable()
export class HelpdeskService {
  private readonly logger = new Logger(HelpdeskService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly holders?: PermissionHoldersService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  /** The employee behind a login: by user id, then by email. */
  private async employeeOf(tenantId: string, userId?: string, email?: string): Promise<any | null> {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let row: any = userId ? await Employee.findOne({ where: { tenantId, userId } }) : null;
    if (!row && email?.trim()) row = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } } });
    return row;
  }

  private async me(tenantId: string, userId?: string, email?: string) {
    const row = await this.employeeOf(tenantId, userId, email);
    if (!row) this.fail(HttpStatus.NOT_FOUND, 'No employee profile is linked to this login.');
    return row;
  }

  private async notify(tenantId: string, employeeId: string | null | undefined, title: string, body: string) {
    if (!employeeId) return;
    try {
      const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
      await Notification.create({ tenantId, employeeId, kind: EmployeeNotificationKind.REQUEST, title, body, readAt: null } as any);
    } catch (error: any) {
      this.logger.warn(`A ticket notification for ${employeeId} was not saved: ${error?.message ?? error}`);
    }
  }

  private async peopleById(tenantId: string, ids: (string | null | undefined)[]) {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!wanted.length) return new Map<string, any>();
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = (await Employee.findAll({ where: { tenantId, id: { [Op.in]: wanted } }, attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'avatarUrl'], raw: true })) as any[];
    return new Map(rows.map((row) => [row.id, row]));
  }

  private row(ticket: any, people: Map<string, any>, forStaff: boolean) {
    const requester = people.get(ticket.requesterId);
    const assignee = ticket.assignedToEmployeeId ? people.get(ticket.assignedToEmployeeId) : null;
    const comments = ((ticket.comments ?? []) as HelpdeskComment[]).filter((comment) => forStaff || !comment.internal);
    return {
      id: ticket.id,
      ticketNumber: ticket.ticketNumber,
      subject: ticket.subject,
      description: ticket.description,
      category: ticket.category,
      priority: ticket.priority,
      status: ticket.status,
      requester: requester ? { id: requester.id, employeeCode: requester.employeeCode ?? null, name: nameOf(requester), avatarUrl: requester.avatarUrl ?? null } : null,
      assignedTo: assignee ? { id: assignee.id, name: nameOf(assignee) } : null,
      resolutionNote: ticket.resolutionNote ?? null,
      resolvedAt: ticket.resolvedAt ?? null,
      comments,
      commentCount: comments.length,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
    };
  }

  private async rowOne(tenantId: string, ticket: any, forStaff: boolean) {
    return this.row(ticket, await this.peopleById(tenantId, [ticket.requesterId, ticket.assignedToEmployeeId]), forStaff);
  }

  private async find(tenantId: string, id: string) {
    const Ticket = await this.modelProvider.getHelpdeskTicketModel(tenantId);
    const ticket: any = await Ticket.findOne({ where: { id, tenantId } });
    if (!ticket) this.fail(HttpStatus.NOT_FOUND, 'Ticket not found.');
    return ticket;
  }

  private async nextNumber(tenantId: string): Promise<string> {
    const Ticket = await this.modelProvider.getHelpdeskTicketModel(tenantId);
    const count = await Ticket.count({ where: { tenantId } });
    return `TKT-${String(count + 1).padStart(4, '0')}`;
  }

  private addComment(ticket: any, comment: HelpdeskComment): HelpdeskComment[] {
    const next = [...((ticket.comments ?? []) as HelpdeskComment[]), comment];
    if (next.length > MAX_COMMENTS) this.fail(HttpStatus.BAD_REQUEST, `A ticket can hold ${MAX_COMMENTS} comments. Open a new ticket for anything further.`);
    return next;
  }

  // ==========================================
  // The employee's own tickets
  // ==========================================

  async listMine(tenantId: string, userId: string, email?: string) {
    const me = await this.me(tenantId, userId, email);
    const Ticket = await this.modelProvider.getHelpdeskTicketModel(tenantId);
    const rows = (await Ticket.findAll({ where: { tenantId, requesterId: me.id }, order: [['createdAt', 'DESC']], limit: 100 })) as any[];
    const people = await this.peopleById(tenantId, [me.id, ...rows.map((row) => row.assignedToEmployeeId)]);
    return {
      open: rows.filter((row) => OPEN_STATUSES.includes(row.status)).length,
      data: rows.map((row) => {
        const { description: _d, comments: _c, ...rest } = this.row(row, people, false);
        return rest;
      }),
    };
  }

  async getMine(tenantId: string, userId: string, email: string | undefined, id: string) {
    const me = await this.me(tenantId, userId, email);
    const ticket = await this.find(tenantId, id);
    if (ticket.requesterId !== me.id) this.fail(HttpStatus.NOT_FOUND, 'Ticket not found.');
    return this.rowOne(tenantId, ticket, false);
  }

  async create(tenantId: string, userId: string, email: string | undefined, dto: CreateMyTicketDto) {
    const me = await this.me(tenantId, userId, email);
    const Ticket = await this.modelProvider.getHelpdeskTicketModel(tenantId);
    const ticket: any = await Ticket.create({
      tenantId,
      ticketNumber: await this.nextNumber(tenantId),
      requesterId: me.id,
      subject: dto.subject.trim(),
      description: dto.description.trim(),
      category: dto.category ?? HelpdeskCategory.OTHER,
      priority: dto.priority ?? HelpdeskPriority.MEDIUM,
      status: HelpdeskStatus.OPEN,
      comments: [],
    } as any);
    await this.notify(tenantId, me.id, `Ticket ${ticket.ticketNumber} raised`, `We have your ticket "${ticket.subject}". IT will pick it up.`);
    await this.holders?.tellPermission(tenantId, 'tickets.manage', [me.id], `New ticket ${ticket.ticketNumber}`, `${nameOf(me) || 'An employee'} raised a ${String(ticket.priority).toLowerCase()} priority ticket: ${ticket.subject}`);
    return this.rowOne(tenantId, ticket, false);
  }

  /** The requester writes on their own ticket. A reply to IT's question puts it back in work. */
  async commentMine(tenantId: string, userId: string, email: string | undefined, id: string, dto: AddTicketCommentDto) {
    const me = await this.me(tenantId, userId, email);
    const ticket = await this.find(tenantId, id);
    if (ticket.requesterId !== me.id) this.fail(HttpStatus.NOT_FOUND, 'Ticket not found.');
    if (ticket.status === HelpdeskStatus.CLOSED) this.fail(HttpStatus.CONFLICT, 'This ticket is closed. Reopen it, or raise a new one.');
    const comments = this.addComment(ticket, { at: new Date().toISOString(), byEmployeeId: me.id, byName: nameOf(me) || 'Requester', staff: false, internal: false, text: dto.text.trim() });
    const status = ticket.status === HelpdeskStatus.WAITING_ON_REQUESTER ? (ticket.assignedToEmployeeId ? HelpdeskStatus.IN_PROGRESS : HelpdeskStatus.OPEN) : ticket.status;
    await ticket.update({ comments, status });
    const title = `Ticket ${ticket.ticketNumber}: new reply`;
    const body = `${nameOf(me) || 'The requester'} replied on "${ticket.subject}".`;
    if (ticket.assignedToEmployeeId) await this.notify(tenantId, ticket.assignedToEmployeeId, title, body);
    else await this.holders?.tellPermission(tenantId, 'tickets.manage', [me.id], title, body);
    return this.rowOne(tenantId, ticket, false);
  }

  /** The requester takes a resolved ticket back into work. */
  async reopenMine(tenantId: string, userId: string, email: string | undefined, id: string) {
    const me = await this.me(tenantId, userId, email);
    const ticket = await this.find(tenantId, id);
    if (ticket.requesterId !== me.id) this.fail(HttpStatus.NOT_FOUND, 'Ticket not found.');
    if (ticket.status !== HelpdeskStatus.RESOLVED) this.fail(HttpStatus.CONFLICT, 'Only a resolved ticket can be reopened.');
    await ticket.update({ status: ticket.assignedToEmployeeId ? HelpdeskStatus.IN_PROGRESS : HelpdeskStatus.OPEN, resolvedAt: null });
    const title = `Ticket ${ticket.ticketNumber} reopened`;
    const body = `${nameOf(me) || 'The requester'} says "${ticket.subject}" is not fixed.`;
    if (ticket.assignedToEmployeeId) await this.notify(tenantId, ticket.assignedToEmployeeId, title, body);
    else await this.holders?.tellPermission(tenantId, 'tickets.manage', [me.id], title, body);
    return this.rowOne(tenantId, ticket, false);
  }

  /** The requester is done with it: a resolved ticket is accepted, an open one is withdrawn. */
  async closeMine(tenantId: string, userId: string, email: string | undefined, id: string) {
    const me = await this.me(tenantId, userId, email);
    const ticket = await this.find(tenantId, id);
    if (ticket.requesterId !== me.id) this.fail(HttpStatus.NOT_FOUND, 'Ticket not found.');
    if (ticket.status === HelpdeskStatus.CLOSED) this.fail(HttpStatus.CONFLICT, 'This ticket is already closed.');
    await ticket.update({ status: HelpdeskStatus.CLOSED });
    if (ticket.assignedToEmployeeId) await this.notify(tenantId, ticket.assignedToEmployeeId, `Ticket ${ticket.ticketNumber} closed`, `${nameOf(me) || 'The requester'} closed "${ticket.subject}".`);
    return this.rowOne(tenantId, ticket, false);
  }

  // ==========================================
  // IT: the queue
  // ==========================================

  async list(tenantId: string, query: GetTicketsQueryDto = {}, actor: { userId?: string; email?: string } = {}) {
    const Ticket = await this.modelProvider.getHelpdeskTicketModel(tenantId);
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);

    const where: any = { tenantId };
    if (query.status) where.status = query.status;
    if (query.priority) where.priority = query.priority;
    if (query.category) where.category = query.category;
    if (query.assigned === 'UNASSIGNED') where.assignedToEmployeeId = null;
    if (query.assigned === 'ME') {
      const me = await this.employeeOf(tenantId, actor.userId, actor.email);
      where.assignedToEmployeeId = me?.id ?? '00000000-0000-0000-0000-000000000000';
    }
    const search = query.search?.trim();
    if (search) where[Op.or] = [{ ticketNumber: { [Op.iLike]: `%${search}%` } }, { subject: { [Op.iLike]: `%${search}%` } }];

    const [total, rows, byStatus] = await Promise.all([
      Ticket.count({ where }),
      Ticket.findAll({ where, order: [['createdAt', 'DESC']], limit, offset: (page - 1) * limit }) as Promise<any[]>,
      Ticket.count({ where: { tenantId }, group: ['status'] }) as unknown as Promise<{ status: string; count: number }[]>,
    ]);
    const people = await this.peopleById(tenantId, rows.flatMap((row) => [row.requesterId, row.assignedToEmployeeId]));
    const counts = (status: HelpdeskStatus) => Number(byStatus.find((entry) => entry.status === status)?.count ?? 0);
    return {
      data: rows.map((row) => {
        const { comments: _c, ...rest } = this.row(row, people, true);
        return { ...rest, commentCount: (row.comments ?? []).length };
      }),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      summary: {
        open: counts(HelpdeskStatus.OPEN),
        inProgress: counts(HelpdeskStatus.IN_PROGRESS),
        waitingOnRequester: counts(HelpdeskStatus.WAITING_ON_REQUESTER),
        resolved: counts(HelpdeskStatus.RESOLVED),
        closed: counts(HelpdeskStatus.CLOSED),
      },
    };
  }

  async get(tenantId: string, id: string) {
    return this.rowOne(tenantId, await this.find(tenantId, id), true);
  }

  /** IT works the ticket: status, priority, who has it, and the resolution. */
  async update(tenantId: string, id: string, dto: UpdateTicketDto, actor: { userId?: string; email?: string } = {}) {
    const ticket = await this.find(tenantId, id);
    const patch: Record<string, unknown> = {};
    const before = ticket.status;
    let status: HelpdeskStatus = dto.status ?? ticket.status;

    if (dto.assignedToEmployeeId !== undefined) {
      if (dto.assignedToEmployeeId) {
        const Employee = await this.modelProvider.getEmployeeModel(tenantId);
        const assignee: any = await Employee.findOne({ where: { id: dto.assignedToEmployeeId, tenantId, status: { [Op.in]: [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE] } } });
        if (!assignee) this.fail(HttpStatus.BAD_REQUEST, 'That person was not found, or no longer works here.');
      }
      patch.assignedToEmployeeId = dto.assignedToEmployeeId;
      // Taking an untouched ticket starts the work.
      if (dto.assignedToEmployeeId && dto.status === undefined && ticket.status === HelpdeskStatus.OPEN) status = HelpdeskStatus.IN_PROGRESS;
    }
    if (dto.priority) patch.priority = dto.priority;

    if (status !== ticket.status || dto.resolutionNote !== undefined) {
      const note = (dto.resolutionNote ?? ticket.resolutionNote ?? '').trim();
      if (status === HelpdeskStatus.RESOLVED && note.length < 3) this.fail(HttpStatus.BAD_REQUEST, 'Say how the ticket was resolved.');
      if (dto.resolutionNote !== undefined) patch.resolutionNote = note || null;
    }
    if (status !== ticket.status) {
      patch.status = status;
      patch.resolvedAt = status === HelpdeskStatus.RESOLVED ? new Date() : null;
    }
    if (!Object.keys(patch).length) return this.rowOne(tenantId, ticket, true);

    await ticket.update(patch);

    const reference = `Ticket ${ticket.ticketNumber}`;
    if (status !== before) {
      const words = { RESOLVED: 'was resolved', CLOSED: 'was closed', WAITING_ON_REQUESTER: 'needs a reply from you', IN_PROGRESS: 'is being worked on', OPEN: 'is open again' } as Record<string, string>;
      await this.notify(tenantId, ticket.requesterId, reference, `"${ticket.subject}" ${words[status]}.${status === HelpdeskStatus.RESOLVED && ticket.resolutionNote ? ` ${ticket.resolutionNote}` : ''}`);
    }
    if (dto.assignedToEmployeeId && dto.assignedToEmployeeId !== ticket.requesterId) {
      const me = await this.employeeOf(tenantId, actor.userId, actor.email);
      if (dto.assignedToEmployeeId !== me?.id) await this.notify(tenantId, dto.assignedToEmployeeId, `${reference} assigned to you`, `"${ticket.subject}" is yours to work.`);
    }
    return this.rowOne(tenantId, ticket, true);
  }

  /** IT answers, or leaves a note only IT sees. */
  async comment(tenantId: string, id: string, dto: AddTicketCommentDto, actor: { userId?: string; email?: string } = {}) {
    const ticket = await this.find(tenantId, id);
    if (ticket.status === HelpdeskStatus.CLOSED) this.fail(HttpStatus.CONFLICT, 'This ticket is closed.');
    const me = await this.employeeOf(tenantId, actor.userId, actor.email);
    const internal = dto.internal === true;
    const comments = this.addComment(ticket, { at: new Date().toISOString(), byEmployeeId: me?.id ?? null, byName: nameOf(me) || actor.email || 'IT', staff: true, internal, text: dto.text.trim() });
    await ticket.update({ comments });
    if (!internal) await this.notify(tenantId, ticket.requesterId, `Ticket ${ticket.ticketNumber}: new reply`, `IT replied on "${ticket.subject}".`);
    return this.rowOne(tenantId, ticket, true);
  }
}
