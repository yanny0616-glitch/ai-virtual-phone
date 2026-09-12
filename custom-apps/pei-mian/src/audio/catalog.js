// ── 内置声音目录：文件在 assets/sounds/<key>.mp3，来源见 assets/sources.json ──
const SOUND_CATEGORIES = [
  { id: "rain", name: "雨" }, { id: "water", name: "水" }, { id: "nature", name: "风与林" },
  { id: "room", name: "室内" }, { id: "travel", name: "旅途" }, { id: "noise", name: "纯噪" }, { id: "mine", name: "我的" },
];
const SOUND_ICONS = {
  rain_light: '<path d="M7 14a4 4 0 1 1 1-7.9A5 5 0 0 1 17.5 8 3.5 3.5 0 0 1 17 15H7z"/><path d="M9 17l-1 3M13 17l-1 3M17 17l-1 3" stroke-linecap="round"/>',
  rain_heavy: '<path d="M7 13a4 4 0 1 1 1-7.9A5 5 0 0 1 17.5 7 3.5 3.5 0 0 1 17 14H7z"/><path d="M8 16l-2 5M12 16l-2 5M16 16l-2 5M20 16l-2 5" stroke-linecap="round"/>',
  rain_window: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M12 3v18M4 12h16"/><path d="M8 7l-1 2.5M16 15l-1 2.5M9 16l-1 2.5M16 6l-1 2.5" stroke-linecap="round"/>',
  thunder: '<path d="M7 13a4 4 0 1 1 1-7.9A5 5 0 0 1 17.5 7 3.5 3.5 0 0 1 17 14h-3"/><path d="M13 11l-3 5h3l-2 5 5-7h-3l2-3z" stroke-linejoin="round"/>',
  waves: '<path d="M3 10c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 20c2-2 4-2 6 0s4 2 6 0 4-2 6 0" stroke-linecap="round"/>',
  stream: '<path d="M4 6c3 0 3 3 6 3s3-3 6-3 3 3 6 3"/><path d="M4 12c3 0 3 3 6 3s3-3 6-3 3 3 6 3"/><path d="M4 18c3 0 3 3 6 3s3-3 6-3 3 3 6 3"/><path d="M8 4l2-1M14 20l2 1" stroke-linecap="round"/>',
  wind: '<path d="M3 8h10a3 3 0 1 0-3-3M3 13h15a3 3 0 1 1-3 3M3 18h8a2 2 0 1 1-2 2" stroke-linecap="round"/>',
  night_crickets: '<path d="M14 4a8 8 0 1 0 6 12 6.5 6.5 0 0 1-6-12z"/><path d="M4 20c2-3 5-3 7 0M6 20l-1 2M9 20l1 2" stroke-linecap="round"/>',
  fire: '<path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z" stroke-linejoin="round"/><path d="M5 21h14" stroke-linecap="round"/>',
  fan: '<circle cx="12" cy="12" r="2"/><path d="M12 10c0-4-2-6-4-6s-2 3 0 5M14 12c4 0 6-2 6-4s-3-2-5 0M12 14c0 4 2 6 4 6s2-3 0-5M10 12c-4 0-6 2-6 4s3 2 5 0"/>',
  aircon: '<rect x="3" y="5" width="18" height="9" rx="2"/><path d="M6 11h12M7 17l-1 3M12 17v3M17 17l1 3" stroke-linecap="round"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2" stroke-linecap="round"/>',
  cat_purr: '<path d="M5 9l1-5 4 3h4l4-3 1 5a7 7 0 1 1-14 0z" stroke-linejoin="round"/><path d="M9 13h.5M14.5 13h.5M11 16c.5.6 1.5.6 2 0" stroke-linecap="round"/>',
  train: '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 10h14M9 14h.5M14.5 14h.5M8 17l-2 4M16 17l2 4" stroke-linecap="round"/>',
  airplane: '<path d="M10 20l1-6-7-2v-2l7 1 3-8h2l-1 8 6 2v2l-6-1-1 6h-1l-1-5-2 5z" stroke-linejoin="round"/>',
  brown_noise: '<path d="M3 14c2-6 4-6 6 0s4 6 6 0 4-6 6 0" stroke-linecap="round"/>',
  pink_noise: '<path d="M3 13c1-4 2-4 3 0s2 4 3 0 2-4 3 0 2 4 3 0 2-4 3 0 2 4 3 0" stroke-linecap="round"/>',
  white_noise: '<path d="M3 12l2-5 2 9 2-8 2 7 2-9 2 8 2-6 2 7 2-5" stroke-linecap="round" stroke-linejoin="round"/>',
  singing_bowl: '<path d="M4 10h16a8 8 0 0 1-16 0z"/><path d="M8 10V7M3 6l1 1M21 6l-1 1" stroke-linecap="round"/><path d="M6 20h12" stroke-linecap="round"/>',
  headphones: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="13" width="4" height="7" rx="1.5"/><rect x="17" y="13" width="4" height="7" rx="1.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4" stroke-linecap="round"/>',
  moon: '<path d="M14 3a8 8 0 1 0 7 11 6.5 6.5 0 0 1-7-11z" stroke-linejoin="round"/>',
};
const iconSvg = key => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${SOUND_ICONS[key] || SOUND_ICONS.headphones}</svg>`;
const BUILTIN_SOUNDS = [
  { key: "rain_light", name: "小雨", cat: "rain", drift: false },
  { key: "rain_heavy", name: "大雨", cat: "rain", drift: true },
  { key: "rain_window", name: "雨打窗", cat: "rain", drift: false },
  { key: "thunder", name: "远雷", cat: "rain", drift: true },
  { key: "waves", name: "海浪", cat: "water", drift: true },
  { key: "stream", name: "溪流", cat: "water", drift: false },
  { key: "wind", name: "旷野的风", cat: "nature", drift: true },
  { key: "night_crickets", name: "夏夜虫鸣", cat: "nature", drift: true },
  { key: "fire", name: "篝火", cat: "nature", drift: true },
  { key: "fan", name: "风扇", cat: "room", drift: false },
  { key: "aircon", name: "空调", cat: "room", drift: false },
  { key: "clock", name: "挂钟", cat: "room", drift: false },
  { key: "cat_purr", name: "猫呼噜", cat: "room", drift: true },
  { key: "train", name: "地铁车厢", cat: "travel", drift: true },
  { key: "airplane", name: "飞机舱", cat: "travel", drift: false },
  { key: "brown_noise", name: "棕噪", cat: "noise", drift: false },
  { key: "pink_noise", name: "粉噪", cat: "noise", drift: false },
  { key: "white_noise", name: "白噪", cat: "noise", drift: false },
  { key: "singing_bowl", name: "颂钵", cat: "noise", drift: true },
];
const MIX_PRESETS = [
  { name: "雨夜壁炉", layers: [{ key: "rain_window", volume: .7 }, { key: "fire", volume: .5 }, { key: "thunder", volume: .25 }] },
  { name: "机舱", layers: [{ key: "airplane", volume: .8 }, { key: "brown_noise", volume: .3 }] },
  { name: "海边帐篷", layers: [{ key: "waves", volume: .7 }, { key: "wind", volume: .35 }, { key: "night_crickets", volume: .3 }] },
  { name: "林间小屋", layers: [{ key: "stream", volume: .5 }, { key: "night_crickets", volume: .5 }, { key: "fire", volume: .35 }] },
  { name: "深夜自习室", layers: [{ key: "clock", volume: .4 }, { key: "fan", volume: .6 }, { key: "rain_light", volume: .4 }] },
  { name: "猫和雨", layers: [{ key: "cat_purr", volume: .6 }, { key: "rain_light", volume: .5 }] },
  { name: "纯棕噪", layers: [{ key: "brown_noise", volume: .8 }] },
];
function findSound(key) {
  return BUILTIN_SOUNDS.find(s => s.key === key) || state.library.find(s => s.key === key) || null;
}
function allSounds() {
  return BUILTIN_SOUNDS.concat(state.library.map(s => ({ key: s.key, name: s.name, icon: s.icon || "headphones", cat: "mine", drift: false, user: true, mediaRef: s.mediaRef })));
}
