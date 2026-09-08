import type { MascotToolContext, MascotToolPackage } from './mascot-tools';
import type { ToolCall, ToolResult } from './tool-executor';
import { readEditObject, readDiyEditObject, prepareEdit, commitEdit, previewEdit, readEditJournal, summarizeEdit, readEditState } from './mascot-edit-store';
import { requiredEditScope, type EditRead, type EditScope, type EditOperation } from './mascot-edit-domain';

const str = (description: string) => ({ type: 'string', description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const READ_SCHEMA = obj({ scope: { type: 'string', enum: ['characters', 'character', 'desktop', 'appearance'] }, id: str('scope=character 时传角色 ID') }, ['scope']);
const DIY_READ_SCHEMA = obj({ templateId: str('DIY 模板 ID'), widgetId: str('可按桌面实例 ID 读取模板和实例配置'), offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 60000 } });
const PREPARE_SCHEMA = obj({
  title: str('简短说明用户想修改什么'),
  reads: { type: 'array', description: '兼容旧调用，可省略。宿主使用本轮真实读取时保存的版本记录，不采用模型填入的 reads；不要自行生成版本。修改前仍须调用读取工具。', items: obj({ scope: { type: 'string', enum: ['characters', 'character', 'desktop', 'appearance'] }, id: str('角色 ID'), revision: str('读取结果中的 revision') }, ['scope', 'revision']) },
  operations: { type: 'array', minItems: 1, maxItems: 50, items: obj({
    action: { type: 'string', enum: ['character.create', 'character.update', 'template.create', 'template.update', 'template.remove', 'widget.update', 'widget.place', 'widget.remove', 'desktop.arrange', 'appearance.update'] },
    id: str('角色、模板或实例的准确 ID'), type: str('widget.place 的内置类型或 DIY 模板 ID'),
    patch: { type: 'string', description: '字段补丁的 JSON 字符串（完整对象）。character: name/persona/personality/briefPersona/tags/addTags/removeTags/avatar/timeZone/wechatID/embeddedWorldBook。template: name/size/htmlString/htmlEdits/bgAssetId/slots；htmlEdits=[{find,replace}] 按唯一原文替换，与 htmlString 二选一。widget: page/row/col/config/type（换成现有 DIY 模板）。desktop.arrange: layout 完整 pageN 图标位置表、dock 完整 ID 数组、folders 完整成员表、placements 组件位置数组[{id,page,row,col}]；未传部分保留。appearance 的字段以读取结果为准；iconSkins/cssOverrides 按键合并。' },
    templatePatch: { type: 'string', description: 'JSON 对象字符串。仅 widget.update：复制当前 DIY 模板并修改，只替换这个实例，保留其他同款。字段同 template.patch。' },
    page: { type: 'integer', minimum: 1, maximum: 50 }, row: { type: 'integer', minimum: 1, maximum: 6 }, col: { type: 'integer', minimum: 1, maximum: 4 },
    place: obj({ page: { type: 'integer' }, row: { type: 'integer' }, col: { type: 'integer' } }),
  }, ['action']) },
}, ['title', 'operations']);
const ID_SCHEMA = obj({ id: str('修改方案 ID，来自准备修改或修改记录') }, ['id']);
export const EDIT_GUIDE = `===== 共同编辑流程 =====
先读取，再准备修改（只存草稿，不写角色/桌面），需要看效果时预览修改，用户已明确要求直接改时可以紧接应用修改。用户说“先看看/先预览”时停在草稿，不应用。应用后返回修改 ID，可用撤销修改恢复。预览窗口也有应用/撤销按钮。
- scope=characters 列角色并供新建；修改既有角色必须 scope=character + ID，完整字段含 tags、头像、时区、微信号、卡内世界书。按名字出现多个匹配必须让用户选 ID。标签增删用 addTags/removeTags 保留其他标签。配角标签只是分类，本工具不会改变记忆库/拾光/挂念的策略。
- scope=desktop 返回准确图标名称/ID、位置、Dock、文件夹及组件实例配置、模板目录。DIY 源码用读取DIY组件，可分段（nextOffset=null 才读完）。内置组件源码不开放，只能改实例配置/位置。
- template.update 更新所有同款。长代码可用 patch.htmlEdits=[{find,replace}] 精确替换唯一原文，未命中或多处命中会拒绝。只改一张用 widget.update 的 templatePatch 复制模板并替换该实例。单改 config 用 patch.config 合并；需要换模板可用 patch.type。改尺寸放不下会拒绝整个方案，不会把原卡偷偷移走。
- desktop.arrange 传最终布局；支持交换、跨页、文件夹及 Dock 整理。保留全部图标、文件夹至少两个成员、Dock 最多四个、不容许重叠。placements 只传要移动的组件。空页可以保留。
- appearance.update 只改读取返回的外观字段。图片必须是已有主题 assetId，可先用导入桌面素材把图像套件素材导入；不能把 CSS 素材 ID 当主题 assetId。iconSkins 按图标 ID 映射；值为空字符串移除该皮肤。globalCustomCSS 是完整自定义 CSS，需要保留原规则。
- 原生工具的 patch/templatePatch 传 JSON 对象字符串，内部会严格解析；文本协议也接受对象。先在本轮调用读取工具，宿主自动保存并使用读取版本；准备修改不必填写 reads，也不要自行生成版本。内容变化导致冲突时重新读取，不盲目重试覆盖。每个方案最多 50 个动作，整体校验、整体保存；修改记录最多 20 项/8MB。
- 音乐 DIY 使用 window.AiPhoneWidget.music：getState() 返回 Promise，subscribe(fn) 返回取消订阅函数；play()/pause()/togglePlay()/prev()/next()/seek(秒)/openPlayer() 均返回 Promise。state={available,track:{id,title,artist,coverUrl}|null,isPlaying,currentTime,duration}。订阅后先 getState 初始化；封面为空做占位。没有当前曲目时显示去音乐 App 选歌。播放控制沿用内部队列，不另建 audio。预览是只读音乐状态，按钮会明确报“请应用到桌面后控制播放”，不会因预览改变当前音乐。
- 完成仅表示已保存并刷新；不能声称模型已看过渲染截图。读取组件诊断可查看 iframe 脚本错误；这是辅助诊断，不是完整视觉验证。
`;
export const MASCOT_EDIT_PACKAGE: MascotToolPackage = {
  id: 'editing_pack', label: '读取预览撤销套件', description: '读取完整角色字段、真实桌面和外观；准备/预览/应用精确修改；保存修改记录并支持有冲突检查的撤销。组件联动内部当前音乐。', usageGuide: EDIT_GUIDE,
  subTools: [
    { name: '读取编辑对象', description: '读取角色/桌面/外观的真实数据和版本。修改之前调用。', parameterSchema: READ_SCHEMA },
    { name: '读取DIY组件', description: '读取已有 DIY 源码（支持分段）、实例配置与摆放位置。', parameterSchema: DIY_READ_SCHEMA },
    { name: '准备修改', description: '根据已读版本生成草稿。只保存方案，原内容不变；返回可预览/应用的 ID。', parameterSchema: PREPARE_SCHEMA },
    { name: '预览修改', description: '打开方案的字段差异、组件效果和桌面布局预览，可以重新打开。', parameterSchema: ID_SCHEMA },
    { name: '应用修改', description: '应用已准备的方案，核对版本、整体写入并保留撤销记录。', parameterSchema: ID_SCHEMA },
    { name: '撤销修改', description: '恢复该次修改前的内容；有后续修改时拒绝覆盖。', parameterSchema: ID_SCHEMA },
    { name: '列出修改记录', description: '列出最近草稿和已应用/撤销方案，可继续预览或应用。', parameterSchema: obj({}) },
    { name: '读取组件诊断', description: '查看当前挂载的 DIY 实例或预览 iframe 报告的脚本错误。', parameterSchema: obj({ widgetId: str('可选实例 ID') }) },
    { name: '导入桌面素材', description: '把图像套件已有素材导入主题素材库，返回外观设置可用的 assetId；不会自动应用。', parameterSchema: obj({ assetId: str('图像处理套件素材 ID'), kind: { type: 'string', enum: ['wallpaper', 'icon_skin', 'dock_skin'] } }, ['assetId', 'kind']) },
  ],
};
export const LEGACY_EDIT_NAMES = ['读取角色', '创建角色', '更新角色字段', '列出组件目录', '查看桌面布局', '创建DIY组件', '更新DIY组件', '摆放组件', '移除DIY组件'];
function remember(ctx: MascotToolContext, read: EditRead) {
  const reads = ctx.editReads ?? (ctx.editReads = []);
  const index = reads.findIndex(r => r.scope === read.scope && r.id === read.id);
  if (index >= 0) reads[index] = read; else reads.push(read);
}
function readsForOperations(ctx: MascotToolContext, operations: EditOperation[]): EditRead[] {
  const scopes = operations.map(requiredEditScope);
  // Both entry points use actual task receipts and retain only edited scopes.
  return (ctx.editReads ?? []).filter(read => scopes.some(scope => scope.scope === read.scope && scope.id === read.id));
}
function openEditPreview(id: string): void {
  if (!previewEdit(id)) throw Error(`预览宿主未挂载，预览未打开；修改方案 ${id} 已保留，可回到小手机界面从修改记录重试预览。本次没有应用修改。`);
}
function resolveCharacterId(args: Record<string, unknown>): string {
  if (typeof args.id === 'string' && args.id) return args.id;
  const found = readEditState().characters.filter(c => c.name === args.name);
  if (found.length !== 1) throw Error(found.length ? '存在同名角色，请使用 id 指定' : '找不到角色，请先列出角色');
  return found[0].id;
}
export async function runMascotEditTool(call: ToolCall, ctx: MascotToolContext): Promise<ToolResult> {
  const a = call.args; const ok = (value: unknown): ToolResult => ({ name: call.name, success: true, data: typeof value === 'string' ? value : JSON.stringify(value) });
  const read = (scope: EditScope, id?: string) => { const result = readEditObject(scope, id); remember(ctx, result.read); return result; };
  switch (call.name) {
    case '读取编辑对象': return ok(read(a.scope as EditScope, a.id as string | undefined));
    case '读取角色': return ok(a.id || a.name ? read('character', resolveCharacterId(a)) : read('characters'));
    case '读取DIY组件': { const result = readDiyEditObject(a); remember(ctx, result.read as EditRead); return ok(result); }
    case '列出组件目录': case '查看桌面布局': return ok(read('desktop'));
    case '列出修改记录': return ok(readEditJournal().map(summarizeEdit));
    case '预览修改': openEditPreview(String(a.id)); return ok('预览已打开；草稿尚未应用，可在窗口查看差异。');
    case '应用修改': case '撤销修改': {
      const plan = await commitEdit(String(a.id), call.name === '撤销修改');
      // Subsequent edits must read the resulting content explicitly.
      ctx.editReads = []; return ok({ ...summarizeEdit(plan), message: '已保存并通知界面刷新；可用修改 ID 查看或撤销。' });
    }
    case '准备修改': {
      const operations = a.operations as EditOperation[];
      return ok(summarizeEdit(await prepareEdit(operations, readsForOperations(ctx, operations), String(a.title || '小卷修改'))));
    }
    case '读取组件诊断': { const { readWidgetDiagnostics } = await import('./widget-music-bridge'); return ok(readWidgetDiagnostics(a.widgetId as string | undefined)); }
    case '导入桌面素材': {
      const { getCssAssetRecord } = await import('./css-asset-storage'); const { loadMediaBlob } = await import('./media-cache-storage'); const { saveThemeAssetFromBlob } = await import('./theme-storage');
      const record = getCssAssetRecord(String(a.assetId)); if (!record) throw Error('找不到图像素材');
      const blob = await loadMediaBlob(record.mediaRef); if (!blob) throw Error('图像素材数据不可用');
      if (!['wallpaper', 'icon_skin', 'dock_skin'].includes(String(a.kind))) throw Error('不支持的素材类型');
      const asset = await saveThemeAssetFromBlob(blob.blob, a.kind as 'wallpaper' | 'icon_skin' | 'dock_skin');
      return ok({ assetId: asset, message: "素材已导入，尚未应用到桌面。" });
    }
  }
  // Old entry points use the same planner and journal. Require their normal read-first workflow.
  let operations: EditOperation[];
  switch (call.name) {
    case '创建角色': { const { name, persona, personality, briefPersona, tags, timeZone, avatar, wechatID } = a;
      const embeddedWorldBook = typeof a.embeddedWorldBook === 'string' ? JSON.parse(a.embeddedWorldBook) : a.embeddedWorldBook;
      operations = [{ action: 'character.create', patch: Object.fromEntries(Object.entries({ name, persona, personality, briefPersona, tags, timeZone, avatar, wechatID, embeddedWorldBook }).filter(([, v]) => v !== undefined)) }]; break; }
    case '更新角色字段': {
      const field = String(a.field);
      const value = typeof a.value === 'string' && ['tags', 'addTags', 'removeTags', 'embeddedWorldBook'].includes(field) ? JSON.parse(a.value) : field === 'avatar' && a.value === 'null' ? null : a.value;
      operations = [{ action: 'character.update', id: resolveCharacterId(a), patch: { [field]: value } }]; break;
    }
    case '创建DIY组件': operations = [{ action: 'template.create', patch: { name: a.name, size: a.size, htmlString: a.htmlString, mode: 'code' }, ...(a.autoPlace !== false ? { place: { page: a.page ?? 1 } } : {}) }]; break;
    case '更新DIY组件': operations = [{ action: 'template.update', id: a.templateId, patch: Object.fromEntries(['name', 'size', 'htmlString'].filter(k => a[k] !== undefined).map(k => [k, a[k]])) }]; break;
    case '摆放组件': operations = [{ ...a, action: 'widget.place' }]; break;
    case '移除DIY组件': operations = [{ action: a.widgetId ? 'widget.remove' : 'template.remove', id: a.widgetId || a.templateId }]; break;
    default: throw Error('未知编辑工具');
  }
  const plan = await prepareEdit(operations, readsForOperations(ctx, operations), call.name);
  if (a.preview === true) { openEditPreview(plan.id); return ok(summarizeEdit(plan)); }
  const result = await commitEdit(plan.id); ctx.editReads = [];
  return ok({ ...summarizeEdit(result), message: '已应用，可按此 ID 撤销；下一次修改前请重新读取。' });
}
