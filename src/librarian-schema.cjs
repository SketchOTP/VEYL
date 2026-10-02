'use strict';
const string = { type: 'string' }, nullableString = { type: ['string', 'null'] };
const nullableStrings = { type: ['array', 'null'], items: string };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const schema = object({
  reply: string,
  clarification: nullableString,
  needsMore: { type: 'boolean' },
  observations: { type: 'array', items: object({ action: { type: 'string', enum: ['list', 'images', 'search', 'properties', 'read-text'] }, path: string, query: nullableString, limit: { type: ['integer', 'null'] }, offset: { type: ['integer', 'null'] }, sort: { type: ['string', 'null'], enum: ['name', 'modified', 'size', 'type', null] }, direction: { type: ['string', 'null'], enum: ['asc', 'desc', null] } }) },
  views: { type: 'array', items: object({ action: { type: 'string', enum: ['navigate', 'select', 'sort', 'view'] }, path: nullableString, paths: nullableStrings, sort: { type: ['string', 'null'], enum: ['name', 'modified', 'size', 'type', null] }, direction: { type: ['string', 'null'], enum: ['asc', 'desc', null] }, view: { type: ['string', 'null'], enum: ['grid', 'list', null] } }) },
  changes: { type: 'array', items: object({ action: { type: 'string', enum: ['new-folder', 'new-file', 'copy', 'move', 'rename', 'duplicate', 'batch-rename', 'trash', 'archive-create', 'archive-extract', 'move-images', 'copy-images', 'trash-images', 'edit-text'] }, paths: nullableStrings, destination: nullableString, name: nullableString, content: nullableString, prefix: nullableString, start: { type: ['integer', 'null'] }, keepExtension: { type: ['boolean', 'null'] }, format: { type: ['string', 'null'], enum: ['zip', 'tar', 'tar.gz', null] } }) }
});
function error(message) { const e = new Error(`Invalid VEYL plan: ${message}`); e.code = 'PLAN_SCHEMA'; throw e; }
function check(value, rule, field = 'response') {
  if (rule.enum && !rule.enum.includes(value)) error(`${field} has an unsupported value.`);
  const allowed = Array.isArray(rule.type) ? rule.type : [rule.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!(allowed.includes(actual) || actual === 'number' && Number.isInteger(value) && allowed.includes('integer'))) error(`${field} has the wrong type.`);
  if (actual === 'string' && value.length > 20000) error(`${field} is too long.`);
  if (actual === 'number' && !Number.isSafeInteger(value)) error(`${field} is not a safe integer.`);
  if (actual === 'object') {
    for (const key of rule.required) if (!Object.hasOwn(value, key)) error(`${field}.${key} is missing.`);
    for (const key of Object.keys(value)) if (!Object.hasOwn(rule.properties, key)) error(`${field}.${key} is not allowed.`);
    for (const [key, item] of Object.entries(rule.properties)) check(value[key], item, `${field}.${key}`);
  }
  if (actual === 'array') {
    if (value.length > (field.endsWith('.paths') ? 500 : 20)) error(`${field} contains too many items.`);
    value.forEach((item, index) => check(item, rule.items, `${field}[${index}]`));
  }
}
function validatePlan(value) {
  check(value, schema);
  if (value.observations.length > 8 || value.views.length > 8 || value.changes.length > 20) error('too many actions.');
  if (value.clarification && (value.changes.length || value.views.length || value.observations.length)) error('a clarification must not carry executable actions.');
  if (value.observations.length && (value.changes.length || value.views.length)) error('observe first; executable actions must use the next response.');
  if (value.views.length && value.changes.length) error('view changes and filesystem changes must be separate responses.');
  if (value.needsMore && !value.observations.length) error('needsMore requires observations.');
  for (const step of value.observations) {
    if (step.action === 'search' && !step.query?.trim()) error('search requires a phrase.');
    if (step.limit !== null && (step.limit < 1 || step.limit > 500)) error('observation limit must be 1–500.');
    if (step.offset !== null && step.offset < 0) error('observation offset must be nonnegative.');
  }
  for (const step of value.views) {
    if (step.action === 'navigate' && !step.path) error('navigate requires a path.');
    if (step.action === 'select' && !step.paths?.length) error('select requires paths.');
    if (step.action === 'sort' && !step.sort) error('sort requires a sort key.');
    if (step.action === 'view' && !step.view) error('view requires grid or list.');
  }
  for (const step of value.changes) {
    if(step.action==='edit-text'&&(step.paths?.length!==1||typeof step.content!=='string'||Buffer.byteLength(step.content)>128*1024||!step.content.isWellFormed()||/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(step.content)))error('edit-text requires one source and bounded UTF-8 replacement content.');
    if(step.action==='edit-text'&&['destination','name','prefix','start','keepExtension','format'].some(key=>step[key]!==null))error('edit-text unused fields must be null.');
    if(step.action!=='edit-text'&&step.content!==null)error('content is used only for edit-text; other actions require null.');
    if (['new-folder', 'new-file'].includes(step.action) && (!step.destination || !step.name)) error('creation requires destination and name.');
    if (!['new-folder', 'new-file'].includes(step.action) && !step.paths?.length) error('file changes require explicit source paths.');
    if (['copy', 'move', 'move-images', 'copy-images'].includes(step.action) && !step.destination) error('transfer requires a destination folder.');
    if (['archive-create', 'archive-extract'].includes(step.action) && (!step.destination || !step.name)) error('archive requires destination and name.');
    if (step.action === 'archive-create' && !step.format) error('archive creation requires a format.');
    if (step.action === 'archive-extract' && step.paths.length !== 1) error('extract requires exactly one archive.');
    if (step.action.endsWith('-images') && step.paths.length !== 1) error('image selection requires exactly one source folder.');
    if (step.action === 'rename' && (!step.name || step.paths.length !== 1)) error('rename requires one source and a new name.');
    if (step.action === 'batch-rename' && !step.prefix) error('batch rename requires a prefix.');
    if (step.start !== null && (step.start < 0 || step.start > 999999)) error('batch starting number is outside range.');
  }
  return value;
}
module.exports = { schema, validatePlan };
