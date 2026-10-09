import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { ConfigService } from '@nestjs/config';
import { Op } from 'sequelize';
import {
  ArticleFilter,
  CreateArticleDto,
  CreateSupportTicketDto,
  CreateVideoTutorialDto,
  GetArticlesQueryDto,
  GetSupportTicketsQueryDto,
  GetVideosQueryDto,
  HelpCategory,
  SupportTicketStatus,
  UpdateArticleDto,
  UpdateSupportTicketDto,
  UpdateVideoTutorialDto,
} from '@app/common';
import { fn, col, QueryTypes } from 'sequelize';
import { PlatformNotificationCategory } from '../models';
import { PlatformNotificationService } from './platform-notification.service';
import { MailService } from './mail.service';
import {
  KnowledgeBaseArticle,
  PlatformSettings,
  SupportTicket,
  VideoTutorial,
} from '../models';

/** Display labels for the category tiles; the enum is the storage form. */
const CATEGORY_LABELS: Record<
  HelpCategory,
  { label: string; description: string }
> = {
  [HelpCategory.GETTING_STARTED]: {
    label: 'Getting Started',
    description: 'Learn the basics of the HRMS platform',
  },
  [HelpCategory.ORGANIZATIONS]: {
    label: 'Organizations',
    description: 'Manage organizations and settings',
  },
  [HelpCategory.USERS_ROLES]: {
    label: 'Users & Roles',
    description: 'Manage users and permissions',
  },
  [HelpCategory.SUBSCRIPTIONS_BILLING]: {
    label: 'Subscriptions & Billing',
    description: 'Plans, billing and invoices',
  },
  [HelpCategory.SYSTEM_MANAGEMENT]: {
    label: 'System Management',
    description: 'Configure and manage systems',
  },
};

/** An article counts as "new" if published within this window. */
const NEW_ARTICLE_WINDOW_DAYS = 30;

@Injectable()
export class HelpSupportService {
  private readonly logger = new Logger(HelpSupportService.name);

  constructor(
    @InjectModel(SupportTicket)
    private readonly ticketModel: typeof SupportTicket,
    @InjectModel(KnowledgeBaseArticle)
    private readonly articleModel: typeof KnowledgeBaseArticle,
    @InjectModel(VideoTutorial)
    private readonly videoModel: typeof VideoTutorial,
    private readonly configService: ConfigService,
    @Optional()
    @InjectModel(PlatformSettings)
    private readonly platformSettings?: typeof PlatformSettings,
    @Optional()
    private readonly platformNotifications?: PlatformNotificationService,
    @Optional() private readonly mailService?: MailService,
  ) {}

  // ==========================================
  // SHARED HELPERS
  // ==========================================

  private formatDuration(seconds?: number | null): string | null {
    if (!seconds || seconds <= 0) return null;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  /** "2.1K views" style compaction used by the video cards. */
  private formatViews(views?: number | null): string {
    const count = views || 0;
    if (count < 1000) return `${count}`;
    if (count < 1_000_000)
      return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }

  private formatTimeAgo(date?: Date | null): string | null {
    if (!date) return null;
    const minutes = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }

  private categoryLabel(category?: HelpCategory | null): string | null {
    return category ? (CATEGORY_LABELS[category]?.label ?? category) : null;
  }

  private toArticleRow(article: KnowledgeBaseArticle) {
    return {
      id: article.id,
      title: article.title,
      slug: article.slug,
      category: article.category,
      categoryLabel: this.categoryLabel(article.category),
      excerpt: article.excerpt,
      views: article.views,
      viewsLabel: this.formatViews(article.views),
      publishedAt: article.publishedAt || article.createdAt,
      timeAgo: this.formatTimeAgo(article.publishedAt || article.createdAt),
    };
  }

  private toVideoRow(video: VideoTutorial) {
    return {
      id: video.id,
      title: video.title,
      category: video.category,
      categoryLabel: this.categoryLabel(video.category),
      description: video.description,
      videoUrl: video.videoUrl,
      thumbnailUrl: video.thumbnailUrl,
      durationSeconds: video.durationSeconds,
      duration: this.formatDuration(video.durationSeconds),
      views: video.views,
      viewsLabel: this.formatViews(video.views),
      publishedAt: video.publishedAt || video.createdAt,
      timeAgo: this.formatTimeAgo(video.publishedAt || video.createdAt),
    };
  }

  private toTicketRow(ticket: SupportTicket) {
    return {
      id: ticket.id,
      ticketNumber: ticket.ticketNumber,
      subject: ticket.subject,
      description: ticket.description,
      category: ticket.category,
      categoryLabel: this.categoryLabel(ticket.category),
      status: ticket.status,
      priority: ticket.priority,
      createdBy: ticket.createdBy,
      createdByName: ticket.createdByName,
      createdByEmail: ticket.createdByEmail,
      createdByRole: ticket.createdByRole,
      tenantId: ticket.tenantId,
      organizationName: ticket.organizationName,
      resolutionNote: ticket.resolutionNote,
      resolvedAt: ticket.resolvedAt,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      timeAgo: this.formatTimeAgo(ticket.createdAt),
      updatedAgo: this.formatTimeAgo(ticket.updatedAt),
    };
  }

  /** A person's display name from their account (organization user or Super Admin). */
  private async accountName(
    id: string,
    isTenantUser: boolean,
  ): Promise<string | null> {
    try {
      const sql = isTenantUser
        ? 'SELECT TRIM(CONCAT_WS(\' \', "firstName", "lastName")) AS name FROM auth_credentials WHERE id = :id LIMIT 1'
        : 'SELECT COALESCE(NULLIF(name, \'\'), TRIM(CONCAT_WS(\' \', "firstName", "lastName"))) AS name FROM super_admins WHERE id = :id LIMIT 1';
      const [row] = await this.ticketModel.sequelize!.query<{
        name: string | null;
      }>(sql, {
        replacements: { id },
        type: QueryTypes.SELECT,
      });
      return row?.name?.trim() || null;
    } catch {
      return null;
    }
  }

  /** The organization's current display name, from the shared platform database. */
  private async organizationName(tenantId: string): Promise<string | null> {
    try {
      const [row] = await this.ticketModel.sequelize!.query<{
        name: string | null;
      }>(
        'SELECT COALESCE(NULLIF("organizationName", \'\'), name) AS name FROM tenants WHERE id = :id LIMIT 1',
        { replacements: { id: tenantId }, type: QueryTypes.SELECT },
      );
      return row?.name ?? null;
    } catch {
      return null;
    }
  }

  // ==========================================
  // CATEGORIES & LANDING PAGE
  // ==========================================

  /** Category tiles with their live article counts. */
  async getCategories() {
    const articles = await this.articleModel.findAll({
      where: { isPublished: true },
      attributes: ['category'],
    });

    const counts = new Map<string, number>();
    for (const article of articles) {
      counts.set(article.category, (counts.get(article.category) || 0) + 1);
    }

    return Object.values(HelpCategory).map((category) => ({
      category,
      label: CATEGORY_LABELS[category].label,
      description: CATEGORY_LABELS[category].description,
      articleCount: counts.get(category) || 0,
    }));
  }

  /**
   * The "Other Ways to Get Help" tiles. URLs are environment-driven because
   * they point at systems outside this codebase (status page, changelog,
   * community forum, feature board); a tile with no configured URL is
   * returned with `url: null` rather than a broken link.
   */
  getResourceLinks() {
    const get = (key: string) => this.configService.get<string>(key) || null;
    return [
      // The platform's own live health check, unless an external status page is configured.
      {
        key: 'systemStatus',
        label: 'System Status',
        description: 'Live health of every service',
        url: get('HELP_SYSTEM_STATUS_URL') || '/system-management',
      },
      {
        key: 'releaseNotes',
        label: 'Release Notes',
        description: 'See latest updates',
        url: get('HELP_RELEASE_NOTES_URL'),
      },
      {
        key: 'community',
        label: 'Community',
        description: 'Join our community',
        url: get('HELP_COMMUNITY_URL'),
      },
      {
        key: 'featureRequests',
        label: 'Feature Requests',
        description: 'Suggest new features',
        url: get('HELP_FEATURE_REQUESTS_URL'),
      },
    ];
  }

  /** Everything the Help & Support landing page renders, in one call. */
  async getOverview() {
    const [categories, trending, recentArticles, videos, tickets] =
      await Promise.all([
        this.getCategories(),
        this.articleModel.findAll({
          where: { isPublished: true },
          order: [['views', 'DESC']],
          limit: 5,
        }),
        this.articleModel.findAll({
          where: { isPublished: true },
          order: [['createdAt', 'DESC']],
          limit: 5,
        }),
        this.videoModel.findAll({
          where: { isPublished: true },
          order: [['createdAt', 'DESC']],
          limit: 5,
        }),
        this.ticketModel.findAll({ order: [['createdAt', 'DESC']], limit: 5 }),
      ]);

    return {
      categories,
      trendingArticles: trending.map((a) => this.toArticleRow(a)),
      newArticles: recentArticles.map((a) => this.toArticleRow(a)),
      videoTutorials: videos.map((v) => this.toVideoRow(v)),
      recentTickets: tickets.map((t) => this.toTicketRow(t)),
      resourceLinks: this.getResourceLinks(),
      supportEmail: await this.supportEmail(),
    };
  }

  /** System Management → General's support email, else the mail reply-to address. */
  private async supportEmail(): Promise<string | null> {
    try {
      const settings = await this.platformSettings?.findOne({
        attributes: ['supportEmail'],
      });
      if (settings?.supportEmail) return settings.supportEmail;
    } catch {
      // Falls back below.
    }
    return this.configService.get<string>('MAIL_REPLY_TO') || null;
  }

  // ==========================================
  // KNOWLEDGE BASE ARTICLES
  // ==========================================

  private slugify(title: string): string {
    return title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120);
  }

  /** Appends a counter when the natural slug is already taken. */
  private async uniqueSlug(title: string): Promise<string> {
    const base = this.slugify(title) || 'article';
    let candidate = base;
    for (let i = 2; i < 100; i++) {
      const clash = await this.articleModel.findOne({
        where: { slug: candidate },
      });
      if (!clash) return candidate;
      candidate = `${base}-${i}`;
    }
    return `${base}-${Date.now()}`;
  }

  async listArticles(query: GetArticlesQueryDto) {
    const page = query?.page && query.page > 0 ? query.page : 1;
    const limit = query?.limit && query.limit > 0 ? query.limit : 10;

    const where: any = { isPublished: true };
    if (query?.category) where.category = query.category;
    if (query?.search) {
      where[Op.or] = [
        { title: { [Op.iLike]: `%${query.search}%` } },
        { excerpt: { [Op.iLike]: `%${query.search}%` } },
      ];
    }

    // Tab semantics: Trending ranks by views; New restricts to the recent
    // window (newest first); All Topics is newest first with no restriction.
    let order: any = [['createdAt', 'DESC']];
    if (query?.filter === ArticleFilter.TRENDING) {
      order = [['views', 'DESC']];
    } else if (query?.filter === ArticleFilter.NEW) {
      where.createdAt = {
        [Op.gte]: new Date(Date.now() - NEW_ARTICLE_WINDOW_DAYS * 86400000),
      };
    }

    const { rows, count } = await this.articleModel.findAndCountAll({
      where,
      order,
      offset: (page - 1) * limit,
      limit,
    });

    return {
      data: rows.map((a) => this.toArticleRow(a)),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
    };
  }

  /** Reading an article counts a view — that's what feeds the Trending tab. */
  async getArticle(id: string, countView = true) {
    const article = await this.articleModel.findByPk(id);
    if (!article) {
      throw new NotFoundException('This article no longer exists.');
    }
    if (countView) {
      await article.increment('views');
      await article.reload();
    }

    return { ...this.toArticleRow(article), content: article.content };
  }

  async createArticle(dto: CreateArticleDto) {
    const article = await this.articleModel.create({
      title: dto.title,
      slug: await this.uniqueSlug(dto.title),
      category: dto.category,
      excerpt: dto.excerpt,
      content: dto.content,
      isPublished: true,
      publishedAt: new Date(),
    });
    return this.toArticleRow(article);
  }

  async updateArticle(id: string, dto: UpdateArticleDto) {
    const article = await this.articleModel.findByPk(id);
    if (!article) {
      throw new NotFoundException(`Article ${id} not found.`);
    }
    await article.update(dto);
    return this.toArticleRow(article);
  }

  async deleteArticle(id: string) {
    const article = await this.articleModel.findByPk(id);
    if (!article) {
      throw new NotFoundException(`Article ${id} not found.`);
    }
    await article.destroy();
    return { success: true };
  }

  // ==========================================
  // VIDEO TUTORIALS
  // ==========================================

  async listVideos(query: GetVideosQueryDto) {
    const page = query?.page && query.page > 0 ? query.page : 1;
    const limit = query?.limit && query.limit > 0 ? query.limit : 10;

    const where: any = { isPublished: true };
    if (query?.category) where.category = query.category;
    if (query?.search) where.title = { [Op.iLike]: `%${query.search}%` };

    const { rows, count } = await this.videoModel.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset: (page - 1) * limit,
      limit,
    });

    return {
      data: rows.map((v) => this.toVideoRow(v)),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
    };
  }

  async getVideo(id: string, countView = true) {
    const video = await this.videoModel.findByPk(id);
    if (!video) {
      throw new NotFoundException('This video no longer exists.');
    }
    if (countView) {
      await video.increment('views');
      await video.reload();
    }
    return this.toVideoRow(video);
  }

  async createVideo(dto: CreateVideoTutorialDto) {
    const video = await this.videoModel.create({
      ...dto,
      isPublished: true,
      publishedAt: new Date(),
    });
    return this.toVideoRow(video);
  }

  async updateVideo(id: string, dto: UpdateVideoTutorialDto) {
    const video = await this.videoModel.findByPk(id);
    if (!video) {
      throw new NotFoundException(`Video ${id} not found.`);
    }
    await video.update(dto);
    return this.toVideoRow(video);
  }

  async deleteVideo(id: string) {
    const video = await this.videoModel.findByPk(id);
    if (!video) {
      throw new NotFoundException(`Video ${id} not found.`);
    }
    await video.destroy();
    return { success: true };
  }

  // ==========================================
  // SUPPORT TICKETS
  // ==========================================

  /**
   * Sequential per-year reference (TKT-2026-0001). `ticketNumber` is unique
   * at the database level, so a concurrent insert that grabs the same number
   * is retried rather than silently colliding.
   */
  private async nextTicketNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const countThisYear = await this.ticketModel.count({
      where: { createdAt: { [Op.gte]: new Date(year, 0, 1) } },
    });
    return `TKT-${year}-${String(countThisYear + 1).padStart(4, '0')}`;
  }

  /**
   * Opens a ticket. One raised by an organization user is stamped with their
   * organization and email (so they hear back) and every Super Admin is told.
   */
  async createTicket(
    dto: CreateSupportTicketDto,
    meta: {
      createdBy?: string;
      createdByName?: string;
      createdByEmail?: string;
      createdByRole?: string;
      tenantId?: string;
    } = {},
  ) {
    const organizationName = meta.tenantId
      ? await this.organizationName(meta.tenantId)
      : null;
    // The token carries an id and email only; the name is on the account.
    if (!meta.createdByName && meta.createdBy) {
      meta = {
        ...meta,
        createdByName:
          (await this.accountName(meta.createdBy, Boolean(meta.tenantId))) ??
          meta.createdByEmail,
      };
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const ticket = await this.ticketModel.create({
          ticketNumber: await this.nextTicketNumber(),
          subject: dto.subject.trim(),
          description: dto.description.trim(),
          category: dto.category,
          priority: dto.priority,
          status: SupportTicketStatus.OPEN,
          createdBy: meta.createdBy,
          createdByName: meta.createdByName,
          createdByEmail: meta.createdByEmail ?? null,
          createdByRole: meta.createdByRole ?? null,
          tenantId: meta.tenantId ?? null,
          organizationName,
        });
        if (meta.tenantId) {
          void this.platformNotifications?.notify({
            category: PlatformNotificationCategory.SYSTEM,
            title: `New support ticket ${ticket.ticketNumber}`,
            body: `${meta.createdByName || meta.createdByEmail || 'Someone'}${organizationName ? ` (${organizationName})` : ''}: ${ticket.subject}`,
            url: '/help-support',
          });
        }
        return this.toTicketRow(ticket);
      } catch (err: any) {
        const isDuplicate = err?.name === 'SequelizeUniqueConstraintError';
        if (!isDuplicate || attempt === 4) throw err;
        this.logger.warn(
          `Ticket number collision, retrying (attempt ${attempt + 1}).`,
        );
      }
    }
    // Unreachable: the loop either returns or rethrows.
    throw new Error('Could not allocate a support ticket number.');
  }

  async listTickets(query: GetSupportTicketsQueryDto) {
    const page = query?.page && query.page > 0 ? query.page : 1;
    const limit = query?.limit && query.limit > 0 ? query.limit : 10;

    // Organization users only ever see their own; the tallies follow the same scope.
    const scope: any = query?.createdBy ? { createdBy: query.createdBy } : {};
    const where: any = { ...scope };
    if (query?.status) where.status = query.status;
    if (query?.search) {
      const term = `%${query.search.trim()}%`;
      where[Op.or] = [
        { ticketNumber: { [Op.iLike]: term } },
        { subject: { [Op.iLike]: term } },
        { organizationName: { [Op.iLike]: term } },
        { createdByName: { [Op.iLike]: term } },
      ];
    }

    const { rows, count } = await this.ticketModel.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset: (page - 1) * limit,
      limit,
    });

    // Status tallies drive the filter chips above the tickets list.
    const grouped = (await this.ticketModel.findAll({
      where: scope,
      attributes: ['status', [fn('COUNT', col('id')), 'total']],
      group: ['status'],
      raw: true,
    })) as unknown as { status: string; total: string }[];
    const countsByStatus = Object.fromEntries(
      Object.values(SupportTicketStatus).map((status) => [
        status,
        Number(grouped.find((g) => g.status === status)?.total ?? 0),
      ]),
    ) as Record<string, number>;

    return {
      data: rows.map((t) => this.toTicketRow(t)),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
      countsByStatus,
    };
  }

  async getTicket(id: string) {
    const ticket = await this.ticketModel.findByPk(id);
    if (!ticket) {
      throw new NotFoundException('This ticket no longer exists.');
    }
    return this.toTicketRow(ticket);
  }

  /**
   * Super Admin's update: status, priority, the reply. When the status moves,
   * the person who raised it is emailed, with the reply if there is one.
   */
  async updateTicket(id: string, dto: UpdateSupportTicketDto) {
    const ticket = await this.ticketModel.findByPk(id);
    if (!ticket) {
      throw new NotFoundException('This ticket no longer exists.');
    }

    const previousStatus = ticket.status;
    const closed = [SupportTicketStatus.RESOLVED, SupportTicketStatus.CLOSED];
    const movingToResolved =
      dto.status &&
      closed.includes(dto.status) &&
      !closed.includes(ticket.status);
    const reopening =
      dto.status &&
      !closed.includes(dto.status) &&
      closed.includes(ticket.status);

    await ticket.update({
      ...dto,
      ...(dto.resolutionNote !== undefined
        ? { resolutionNote: dto.resolutionNote.trim() || null }
        : {}),
      ...(movingToResolved ? { resolvedAt: new Date() } : {}),
      ...(reopening ? { resolvedAt: null } : {}),
    });

    if (dto.status && dto.status !== previousStatus)
      void this.emailTicketUpdate(ticket);
    return this.toTicketRow(ticket);
  }

  private async emailTicketUpdate(ticket: SupportTicket) {
    if (!this.mailService || !ticket.createdByEmail) return;
    const STATUS: Record<string, string> = {
      [SupportTicketStatus.OPEN]: 'reopened',
      [SupportTicketStatus.IN_PROGRESS]: 'being worked on',
      [SupportTicketStatus.RESOLVED]: 'resolved',
      [SupportTicketStatus.CLOSED]: 'closed',
    };
    const subject = `Your support ticket ${ticket.ticketNumber} is ${STATUS[ticket.status] ?? 'updated'}`;
    const message = [
      `“${ticket.subject}” is now ${STATUS[ticket.status] ?? ticket.status.toLowerCase()}.`,
      ticket.resolutionNote ? `\nOur reply:\n${ticket.resolutionNote}` : '',
      '\nYou can follow it under Help → My Tickets.',
    ]
      .filter(Boolean)
      .join('\n');
    try {
      await this.mailService.sendTemplateEmail({
        to: ticket.createdByEmail,
        subject,
        templateName: 'notice',
        variables: { title: subject, message },
      });
    } catch (err: any) {
      this.logger.warn(
        `Ticket update email to ${ticket.createdByEmail} failed: ${err?.message}`,
      );
    }
  }
}
