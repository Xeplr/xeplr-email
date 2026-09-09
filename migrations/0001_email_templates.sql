-- 0001_email_templates.sql
-- Named, reusable emails — "User Registration", "Password Reset" — so a
-- sender picks a template and supplies variables instead of restating a
-- subject and a body every time it wants to send the same message.
--
-- WHY THIS LIVES IN THE EMAIL SERVICE and not in whatever wants to send:
-- everything here sends mail (auth's activation, workflow steps, job
-- notifications). A template owned by one product would be invisible to the
-- rest, and "User Registration" would end up written three times in three
-- places, drifting apart. One store, every product.
--
-- `variables` is the DECLARED list the body expects — [{ name, description,
-- required }]. It is not derived from the body by scanning for {{tokens}},
-- because a declaration is what lets a caller's UI render a form and catch a
-- missing value BEFORE sending, rather than mailing somebody "Hello ,".
--
-- `name` is unique and is what callers store: a workflow step referencing a
-- template by uuid would be unreadable in a diff and unportable between
-- environments, where the same template has different ids.

CREATE TABLE IF NOT EXISTS "email_templates" (
  "id"                  varchar(25) PRIMARY KEY,
  "name"                varchar(128) NOT NULL,
  "description"         text,
  "subject"             text NOT NULL,
  "html"                text,
  "text"                text,
  -- [{ name, description, required }] — see above.
  "variables"           jsonb NOT NULL DEFAULT '[]'::jsonb,
  "isActive"            boolean NOT NULL DEFAULT true,
  "recordCreatedDate"   timestamptz DEFAULT now(),
  "recordModifiedDate"  timestamptz,
  "recordCreatedBy"     varchar(25),
  "recordModifiedBy"    varchar(25)
);

-- Unique among LIVE templates only. A soft-deleted "User Registration" must
-- not block creating its replacement, which a plain UNIQUE constraint would.
CREATE UNIQUE INDEX IF NOT EXISTS "email_templates_name_active_idx"
  ON "email_templates" ("name") WHERE "isActive";
