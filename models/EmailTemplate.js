var { BaseModel } = require('@xeplr/db');

// TENANT COLUMNS, RESOLVED BY HAND — see migrations/0002_templates_tenancy.sql.
//
// `multiTenant` stays false on purpose even though mtId1 now exists: BaseModel's
// automatic filter would return NOTHING for the sends described below, which is
// silence rather than an error. lib/templates.js resolves instead — the
// tenant's own row if there is one, the platform row (mtId1 null) otherwise.
//
// The original note, kept because its reasoning is what shaped the above:
//
// The email service is shared infrastructure — auth, jobs and workflow all
// send through it, and several of them send BEFORE any tenant context exists
// (an activation mail goes out while the user is still being created). Tenant
// columns here would have to be nullable and unenforced, which is the worst of
// both: it looks scoped and isn't.
//
// The consequence to know: a template is visible to every company on the
// install. Fine for one tenant, and fine for templates that are genuinely
// platform-level (activation, password reset). It is WRONG the day two
// companies want their own branded "User Registration" — that needs mt columns
// on this table, not a filter bolted on above it. See @xeplr/jobs, which has
// exactly this note for the same reason.
class EmailTemplate extends BaseModel {
  static get tableName() { return 'email_templates'; }
  static get idColumn() { return 'id'; }
  static get multiTenant() { return false; }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'name', 'subject'],
      properties: {
        id: { type: 'string', maxLength: 25 },
        name: { type: 'string', maxLength: 128 },
        description: { type: ['string', 'null'] },
        subject: { type: 'string' },
        html: { type: ['string', 'null'] },
        text: { type: ['string', 'null'] },
        // [{ name, description, required }]
        variables: { type: ['array', 'null'] },
        // Null = platform: usable by every tenant, owned by none.
        mtId1: { type: ['string', 'null'], maxLength: 25 },
        isActive: { type: 'boolean' },
        recordCreatedDate: { type: ['string', 'null'] },
        recordModifiedDate: { type: ['string', 'null'] },
        recordCreatedBy: { type: ['string', 'null'], maxLength: 25 },
        recordModifiedBy: { type: ['string', 'null'], maxLength: 25 }
      }
    };
  }
}

module.exports = EmailTemplate;
