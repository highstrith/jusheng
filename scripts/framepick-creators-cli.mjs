// Framepick creator admin CLI: applications, manual intake ("人工投稿") and the
// review trail. Operations run against the store outside the repository; private
// material stays out of Git and out of the published page.
//
//   node scripts/framepick-creators-cli.mjs application list [--status submitted]
//   node scripts/framepick-creators-cli.mjs application show app_1a2b
//   node scripts/framepick-creators-cli.mjs application approve app_1a2b --note "材料齐全"
//   node scripts/framepick-creators-cli.mjs invite 张小千 --email creator@example.com --contact https://...
//   node scripts/framepick-creators-cli.mjs submission list [--application app_1a2b]
//   node scripts/framepick-creators-cli.mjs submission status sub_1a2b accepted --note "审片通过"
//   node scripts/framepick-creators-cli.mjs submission convert sub_1a2b --cover img/guiyuan-640w.webp [--id guiyuan]
//   node scripts/framepick-creators-cli.mjs submit-for app_1a2b --file work.json
//   node scripts/framepick-creators-cli.mjs log -n 20
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCreatorStore, APPLICATION_STATUSES, SUBMISSION_STATUSES } = require('../server/framepick-creators.cjs');

const [group, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const index = rest.indexOf(`--${name}`);
  return index < 0 ? undefined : rest[index + 1];
};
const has = (name) => rest.includes(`--${name}`);
const positional = rest.filter((value, index) => !value.startsWith('--') && (index === 0 || !rest[index - 1].startsWith('--')));
const isGroup = group === 'application' || group === 'submission';
const positional = rest.filter((value, index) => !value.startsWith('--') && (index === 0 || !rest[index - 1].startsWith('--')));
const action = isGroup ? positional[0] : group;
const target = isGroup ? positional[1] : positional[0];
const value = isGroup ? positional[2] : positional[1];

const store = createCreatorStore({
  dataDir: process.env.FRAMEPICK_CREATORS_DATA_DIR,
  libraryDataDir: process.env.FRAMEPICK_LIBRARY_DATA_DIR,
});

function readPayload() {
  const file = flag('file');
  if (file) return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const inline = flag('json');
  if (inline) return JSON.parse(inline);
  throw new Error('需要 --file <路径> 或 --json <JSON>');
}

function print(value) {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

const briefApplication = (item) => `${item.id}  ${item.status.padEnd(10)}  ${item.name}${item.invited ? '  (邀请)' : ''}  ${item.createdAt.slice(0, 10)}`;
const briefSubmission = (item) => `${item.id}  ${item.status.padEnd(12)}  ${item.title}  ${item.filmId ? `→ ${item.filmId}` : ''}`;

function usage() {
  console.log(`用法：
  application list [--status ${APPLICATION_STATUSES.join('|')}]
  application show <id>
  application <${APPLICATION_STATUSES.join('|')}> <id> [--note "审核意见"]
  invite <名称> [--email x@y.com] [--contact https://...] [--intro ...] [--aiUsage ...]
  submission list [--status ${SUBMISSION_STATUSES.join('|')}] [--application <id>]
  submission show <id>
  submission <${SUBMISSION_STATUSES.join('|')}> <id> [--note "审核意见"]
  submission convert <id> --cover img/x-640w.webp [--id film-id] [--json '{...}']
  submit-for <applicationId> --file work.json
  log [-n 20]`);
  process.exitCode = 1;
}

try {
  if (group === 'application') {
    if (action === 'list') {
      const list = store.listApplications(flag('status'));
      console.log(list.length ? list.map(briefApplication).join('\n') : '（无创作者申请）');
    } else if (action === 'show') {
      print(store.getApplication(target));
    } else if (APPLICATION_STATUSES.includes(action)) {
      const note = flag('note');
      if (note) store.addApplicationNote(target, note, { actor: 'operator' });
      const updated = store.setApplicationStatus(target, action, { actor: 'operator', note });
      console.log(`${updated.id} → ${updated.status}`);
    } else usage();
  } else if (group === 'submission') {
    if (action === 'list') {
      const list = store.listSubmissions({ status: flag('status'), applicationId: flag('application') });
      console.log(list.length ? list.map(briefSubmission).join('\n') : '（无投稿）');
    } else if (action === 'show') {
      print(store.getSubmission(target));
    } else if (action === 'convert') {
      const filmInput = has('file') || has('json') ? readPayload() : {};
      const cover = flag('cover') || filmInput.cover;
      if (!cover) throw new Error('转换需要封面路径：--cover img/x-640w.webp');
      const id = flag('id') || filmInput.id;
      const result = store.convertSubmission(target, { ...filmInput, cover, ...(id ? { id } : {}) }, { actor: 'operator' });
      console.log(`${result.submission.id} → 作品 ${result.film.id}（status=${result.film.status}）`);
      console.log('下一步：用片库命令推进审核并重新生成页面');
      console.log(`  node scripts/framepick-library-cli.mjs status ${result.film.id} reviewing`);
      console.log('  node scripts/build-framepick-library.mjs');
    } else if (SUBMISSION_STATUSES.includes(action)) {
      const note = flag('note');
      if (note) store.addSubmissionNote(target, note, { actor: 'operator' });
      const updated = store.setSubmissionStatus(target, action, { actor: 'operator', note });
      console.log(`${updated.id} → ${updated.status}`);
    } else usage();
  } else if (group === 'invite') {
    // The operator vouches for this creator, so the record starts approved: this
    // is the "创作者邀请／人工投稿" path, no public sign-up involved.
    const application = store.addApplication({
      name: target,
      email: flag('email') || '',
      contact: flag('contact') || '',
      intro: flag('intro') || `由运营邀请入驻（${new Date().toISOString().slice(0, 10)}）`,
      aiUsage: flag('aiUsage') || '待创作者补充',
      samples: flag('samples') ? flag('samples').split(',') : [],
      invited: true,
    }, { actor: 'operator' });
    console.log(`${application.id}  ${application.status}  ${application.name}`);
  } else if (group === 'submit-for') {
    const payload = readPayload();
    const submission = store.addSubmission({ ...payload, applicationId: target }, { actor: 'operator' });
    console.log(`${submission.id}  ${submission.status}  ${submission.title}`);
  } else if (group === 'log') {
    print(store.log(Number(flag('n')) || 20));
  } else usage();
} catch (error) {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
}
