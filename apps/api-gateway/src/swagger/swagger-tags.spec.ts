import { SHARED_TAGS, SWAGGER_PORTALS, SWAGGER_TAG_GROUPS, TAGS } from './swagger-tags';

/**
 * The taxonomy is only useful while it stays complete. A tag that nobody
 * registered renders as a bare heading with no description; one that belongs
 * to no portal quietly vanishes from every per-portal page while still
 * appearing on the combined one, which is the sort of gap nobody notices
 * until a frontend team reports a missing endpoint.
 */
describe('swagger taxonomy', () => {
  const allTags = Object.values(TAGS);

  it('describes every tag in the sidebar order', () => {
    const described = new Set(SWAGGER_TAG_GROUPS.map((group) => group.name));
    const missing = allTags.filter((tag) => !described.has(tag));

    expect(missing).toEqual([]);
  });

  it('does not describe a tag that no longer exists', () => {
    const known = new Set<string>(allTags);
    const orphaned = SWAGGER_TAG_GROUPS.map((group) => group.name).filter(
      (name) => !known.has(name),
    );

    expect(orphaned).toEqual([]);
  });

  it('lists each tag once', () => {
    const names = SWAGGER_TAG_GROUPS.map((group) => group.name);

    expect(names).toHaveLength(new Set(names).size);
  });

  it('files every tag under at least one portal', () => {
    const placed = new Set<string>([
      ...SHARED_TAGS,
      ...SWAGGER_PORTALS.flatMap((portal) => portal.tags),
    ]);
    const unplaced = allTags.filter((tag) => !placed.has(tag));

    expect(unplaced).toEqual([]);
  });

  it('gives every portal a distinct slug', () => {
    const slugs = SWAGGER_PORTALS.map((portal) => portal.slug);

    expect(slugs).toHaveLength(new Set(slugs).size);
    // The slug becomes a URL segment under /api/docs.
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it('gives every portal screens of its own', () => {
    for (const portal of SWAGGER_PORTALS) {
      expect(portal.tags.length).toBeGreaterThan(0);
      expect(portal.title.trim()).not.toBe('');
      expect(portal.description.trim()).not.toBe('');
    }
  });

  it('keeps the employee portal to self-service screens', () => {
    const employee = SWAGGER_PORTALS.find((portal) => portal.slug === 'employee');

    // An admin screen leaking onto the employee page would advertise routes
    // the employee's token cannot call.
    expect(employee?.tags).toContain(TAGS.ORG_EMPLOYEE_PORTAL);
    expect(employee?.tags).not.toContain(TAGS.ORG_EMPLOYEES);
    expect(employee?.tags).not.toContain(TAGS.ORG_HR_PORTAL);
    expect(employee?.tags.some((tag) => tag.startsWith('SuperAdmin:'))).toBe(false);
  });

  it('gives the HR portal its dashboard, reports and the screens it manages', () => {
    const hr = SWAGGER_PORTALS.find((portal) => portal.slug === 'hr');

    expect(hr?.tags).toEqual(
      expect.arrayContaining([
        TAGS.ORG_HR_PORTAL,
        TAGS.ORG_HR_REPORTS,
        TAGS.ORG_EMPLOYEES,
        TAGS.ORG_ATTENDANCE,
        TAGS.ORG_LEAVE,
        TAGS.ORG_ONBOARDING,
        TAGS.ORG_POLICIES,
      ]),
    );
    expect(hr?.tags).not.toContain(TAGS.ORG_EMPLOYEE_PORTAL);
  });

  /** Login, files and the health probe are reachable from every portal. */
  it('shares auth, files and health rather than duplicating them per portal', () => {
    expect(SHARED_TAGS).toEqual(
      expect.arrayContaining([TAGS.ORG_AUTH, TAGS.PLATFORM_FILES, TAGS.PLATFORM_HEALTH]),
    );
    for (const portal of SWAGGER_PORTALS) {
      for (const shared of SHARED_TAGS) {
        expect(portal.tags).not.toContain(shared);
      }
    }
  });
});
