// 「不用人工审核」这条放行规则的测试。规则错一步，就会把发布会回放或狗血短剧
// 直接推到公开页面上，所以每条剔除理由都要有用例。
import assert from 'node:assert/strict';
import test from 'node:test';
import { filmTitle, publishability, runtimeSecondsFromNote } from '../scripts/framepick-publish-rules.mjs';

const item = (title, note = '时长 12:00') => ({ title, note });

test('a long film with a real title is publishable', () => {
  const result = publishability(item('AI科幻短片《第32号塔/Tower32》'));
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.runtimeSeconds, 720);
});

test('eight minutes or less is not enough', () => {
  assert.equal(publishability(item('《带你去玩球》', '时长 08:00')).eligible, false);
  assert.match(publishability(item('《带你去玩球》', '时长 08:00')).reasons.join(), /不超过 8 分钟/);
  assert.equal(publishability(item('《带你去玩球》', '时长 09:21')).eligible, true);
});

test('missing runtime cannot be waved through', () => {
  const result = publishability({ title: '《某片》', note: '抖音搜索「AI 短片」· 2天前' });
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(), /没有可核实的时长/);
});

test('reporting and tool videos are rejected', () => {
  for (const title of [
    '首个面向主动智能体的细粒度人类评估基准HALO发布！',
    '蚂蚁集团推出2B参数视觉取证大模型',
    '国产首部AI院线电影首日预售仅数万',
    '影视飓风AI影片“以假乱真”的 2 个底层密码',
  ]) {
    const result = publishability(item(title));
    assert.equal(result.eligible, false, `${title} 不该放行`);
  }
});

test('derivative works and compilations are rejected', () => {
  assert.match(publishability(item('AI制作海贼王同人短片：路飞穿越回神之谷')).reasons.join(), /同人二创/);
  assert.match(publishability(item('未来城市精选集2：超越想象 科幻AI短片')).reasons.join(), /合集／预告/);
});

test('a series is only publishable from its first episode', () => {
  assert.equal(publishability(item('鳄鱼缅北第123集')).eligible, false);
  assert.match(publishability(item('自制AI短剧《林满不满》EP09')).reasons.join(), /系列中间集/);
  // 第一集、EP01、第 1 集都是入口，不能一起挡掉。
  for (const title of ['原创AI剧《南天门计划》第一集', '自制AI短剧《我的妹妹》EP01', '《相见欢》第 1 集：钟山谶']) {
    assert.equal(publishability(item(title)).eligible, true, `${title} 是第一集，应放行`);
  }
});

test('salacious short-drama titles are rejected', () => {
  for (const title of [
    '(超长版)目睹了老板包养小三的全过程，命运的齿轮就此开始了',
    '姐姐逃婚，我代替她嫁给纯良傻子总裁后，却发现…（纯享版）',
  ]) {
    assert.match(publishability(item(title, '时长 30:00')).reasons.join(), /狗血擦边/);
  }
});

test('a title with no film name is rejected', () => {
  assert.match(publishability(item('AI生成的科幻短片')).reasons.join(), /没有片名/);
  assert.equal(publishability(item('AI科幻短片《第32号塔》')).eligible, true);
});

test('runtime is read out of the candidate note', () => {
  assert.equal(runtimeSecondsFromNote('抖音搜索「AI 短片」· 2天前 · 时长 21:03'), 1263);
  assert.equal(runtimeSecondsFromNote('抖音搜索「AI 短片」· 2天前'), null);
});

test('the film name is picked out of the long douyin title', () => {
  assert.equal(filmTitle('AI短片《烟花开在海的背面》 奇幻世界与现实或许存在交界'), '烟花开在海的背面');
  assert.equal(filmTitle('20分钟AIGC真人武侠电影《哑镖》'), '哑镖');
  assert.equal(filmTitle('原创AI动画短片《星辰岛》全长13分钟'), '星辰岛');
  assert.equal(filmTitle('朋友说我手搓出来了一集爱死机 梯城'), '朋友说我手搓出来了一集爱死机梯城');
});

test('the same film on another platform is a duplicate, not a new entry', () => {
  const films = [{ title: '烟花开在海的背面' }];
  const result = publishability(item('AI短片《烟花开在海的背面》 奇幻世界与现实或许存在交界'), { films });
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(), /重复：片库里已有《烟花开在海的背面》/);

  // 同一批候选里互相重复也要挡住。
  const siblings = ['《白昼禁区》凌晨两点突然天亮', '白昼禁区'];
  assert.match(publishability(item('白昼禁区'), { siblings }).reasons.join(), /候选池里已有同片/);
  // 名字相近但不是同一部的，不能误判成重复。
  assert.equal(publishability(item('《白昼禁区》凌晨两点突然天亮'), { films: [{ title: '白昼' }] }).eligible, true);
});
