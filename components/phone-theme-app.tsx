"use client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  AppWindow,
  Check,
  Code2,
  Download,
  Layers,
  LayoutGrid,
  PaintBucket,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Smartphone,
  Sparkles,
  Trash2,
  Type,
  Upload,
  Wallpaper,
} from "lucide-react";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { GlassIcon } from "@/components/ui/glass-icon";
import { normalizeThemeProfile, resolveActiveIconSkins, DEFAULT_THEME_PROFILE, type ThemeProfile } from "@/lib/theme-types";
import type { DesktopIconId, IconId } from "@/lib/desktop-config";
import { DOCK_DEFAULT, PAGE_1_DEFAULT, PAGE_2_DEFAULT, PAGE_3_DEFAULT, ICONS } from "@/lib/desktop-config";
import type { DesktopFolderMap, DesktopIconLayout } from "@/lib/desktop-layout-storage";
import { CUSTOM_APPS_UPDATED_EVENT, loadInstalledCustomApps } from "@/lib/custom-app-storage";
import { toCustomAppIconId, type InstalledCustomApp } from "@/lib/custom-app-types";
import { PageShell } from "@/components/ui/page-shell";
import { readPwaDisplayPreference, writePwaDisplayPreference } from "@/lib/pwa-display-mode";
import {
  GRID_COLS,
  GRID_ROWS,
  WIDGET_CATALOG,
  WIDGET_SIZE_CELLS,
  type WidgetInstance,
  type WidgetType,
} from "@/lib/widget-types";
import {
  buildOccupancyGrid,
  canPlaceWidget,
  placeWidget,
  removeWidget,
  loadDIYTemplates,
  saveDIYTemplates,
} from "@/lib/widget-storage";
import { WidgetRenderer } from "@/components/widgets/widget-renderer";
import { IconGlyph } from "@/components/icon-glyph";
import {
  saveThemeAssetFromBlob,
  deleteThemeAsset,
  getThemeAssetMap,
  describeAssetSaveError,
} from "@/lib/theme-storage";
import { BINDING_ACCENTS } from "@/lib/ui-accent-colors";
import { ConfirmDialog, ContentDialog } from "@/components/ui/modal";
import type { DIYWidgetTemplate } from "@/lib/widget-types";
import { DIYWidgetEditor } from "@/components/widgets/diy-widget-editor";
import {
  createThemePackageBlob,
  installThemePackageFile,
  resetThemePackageState,
} from "@/lib/theme-package";
import {
  APPEARANCE_PRESET_MAX,
  deleteAppearancePreset,
  describeAppearancePreset,
  isThemeAssetReferencedByPresets,
  loadAppearancePresets,
  overwriteAppearancePreset,
  renameAppearancePreset,
  saveAppearancePreset,
  type AppearancePreset,
} from "@/lib/appearance-presets";
import { notifyDesktopWidgetsChanged } from "@/lib/mascot-events";
import {
  CUSTOM_SPLASH_MAX,
  SPLASH_VARIANTS,
  customSplashVariantId,
  deleteCustomSplash,
  loadCustomSplashes,
  readSplashVariant,
  saveCustomSplash,
  writeSplashVariant,
  type CustomSplash,
  type SplashVariantId,
} from "@/lib/splash-config";
import { SplashPreview, SplashVariant } from "@/components/splash-variants";

type ThemeSection =
  | "menu"
  | "palette"
  | "wallpaper"
  | "icons"
  | "widgets"
  | "case"
  | "text"
  | "css"
  | "presets"
  | "splash";

type ThemeMenuItemSection = Exclude<ThemeSection, "menu"> | "transfer" | "reset";
type WallpaperSliderField = "wallpaperOpacity" | "wallpaperBlur" | "wallpaperScale" | "wallpaperX" | "wallpaperY";

type PhoneThemeAppProps = {
  draft: ThemeProfile;
  onDraftChange: (next: ThemeProfile) => void;
  onApply: (next: ThemeProfile) => Promise<void> | void;
  onClose: () => void;
  onNotice: (text: string) => void;
  widgets: WidgetInstance[];
  onWidgetsChange: (next: WidgetInstance[]) => void;
  onDesktopThemeChange: (next: {
    widgets: WidgetInstance[];
    iconLayout: DesktopIconLayout;
    dock?: DesktopIconId[];
    folders?: DesktopFolderMap;
  }) => void;
  pageIcons: DesktopIconLayout;
  iconSkins: Record<string, string | null>;
  wallpaperStyle?: CSSProperties;
};

function IconChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function IconPalette() {
  return <PaintBucket size={22} strokeWidth={1.75} />;
}

function IconWallpaper() {
  return <Wallpaper size={22} strokeWidth={1.75} />;
}

function IconGrid() {
  return <LayoutGrid size={22} strokeWidth={1.75} />;
}

function IconWidgets() {
  return <AppWindow size={22} strokeWidth={1.75} />;
}

function IconCase() {
  return <Smartphone size={22} strokeWidth={1.75} />;
}

function IconText() {
  return <Type size={22} strokeWidth={1.75} />;
}

function IconCode() {
  return <Code2 size={22} strokeWidth={1.75} />;
}

function IconTransfer() {
  return <Download size={22} strokeWidth={1.75} />;
}

function IconReset() {
  return <RotateCcw size={22} strokeWidth={1.75} />;
}

function IconPresets() {
  return <Layers size={22} strokeWidth={1.75} />;
}

function IconSplash() {
  return <Sparkles size={22} strokeWidth={1.75} />;
}

const MENU_ITEMS: Array<{
  section: ThemeMenuItemSection;
  icon: () => React.JSX.Element;
  /** 菜单里用的玻璃图标名，见 assets/glass-icons/ */
  glass: string;
  label: string;
  desc?: string;
  color?: string;
  glow?: string;
}> = [
  { section: "palette", icon: IconPalette, label: "主题色", desc: "调色板预设", color: BINDING_ACCENTS.preset, glow: `color-mix(in srgb, ${BINDING_ACCENTS.preset} 35%, transparent)`, glass: "palette" },
  { section: "wallpaper", icon: IconWallpaper, label: "壁纸", desc: "桌面背景", color: BINDING_ACCENTS.api, glow: `color-mix(in srgb, ${BINDING_ACCENTS.api} 35%, transparent)`, glass: "wallpaper" },
  { section: "icons", icon: IconGrid, label: "图标", desc: "应用图标", color: BINDING_ACCENTS.regex, glow: `color-mix(in srgb, ${BINDING_ACCENTS.regex} 35%, transparent)`, glass: "icons" },
  { section: "widgets", icon: IconWidgets, label: "桌面组件", desc: "小组件", color: BINDING_ACCENTS.voice, glow: `color-mix(in srgb, ${BINDING_ACCENTS.voice} 35%, transparent)`, glass: "widgets" },
  { section: "case", icon: IconCase, label: "状态栏", color: BINDING_ACCENTS.memory, glass: "status-bar" },
  { section: "text", icon: IconText, label: "文字", color: BINDING_ACCENTS.identity, glow: `color-mix(in srgb, ${BINDING_ACCENTS.identity} 35%, transparent)`, glass: "text" },
  { section: "css", icon: IconCode, label: "CSS 变量", desc: "自定义全局样式变量", color: BINDING_ACCENTS.embedding, glow: `color-mix(in srgb, ${BINDING_ACCENTS.embedding} 35%, transparent)`, glass: "css" },
  { section: "presets", icon: IconPresets, label: "外观预设", desc: "存多套外观，一键切换", color: BINDING_ACCENTS.preset, glow: `color-mix(in srgb, ${BINDING_ACCENTS.preset} 35%, transparent)`, glass: "presets" },
  { section: "splash", icon: IconSplash, label: "开屏动画", desc: "换一套开机画面", color: BINDING_ACCENTS.voice, glass: "quick-action" },
  { section: "transfer", icon: IconTransfer, label: "主题导入 / 导出", desc: "备份与迁移", color: BINDING_ACCENTS.api, glow: `color-mix(in srgb, ${BINDING_ACCENTS.api} 35%, transparent)`, glass: "theme-transfer" },
  { section: "reset", icon: IconReset, label: "恢复默认", desc: "重置外观", color: BINDING_ACCENTS.regex, glow: `color-mix(in srgb, ${BINDING_ACCENTS.regex} 30%, transparent)`, glass: "theme-reset" },
];

const menuIconStyle = (color?: string): CSSProperties => ({
  "--icon-color": color ?? "var(--c-icon)",
} as CSSProperties);

const SECTION_TITLES: Record<Exclude<ThemeSection, "menu">, string> = {
  palette: "\u4E3B\u9898\u8272",
  wallpaper: "\u58C1\u7EB8",
  icons: "\u56FE\u6807",
  widgets: "\u684C\u9762\u7EC4\u4EF6",
  case: "\u624B\u673A\u58F3",
  text: "\u6587\u5B57",
  css: "CSS \u53D8\u91CF",
  presets: "外观预设",
  splash: "开屏动画",
};

const THEME_SECTIONS = new Set<string>(["menu", "palette", "wallpaper", "icons", "widgets", "case", "text", "css", "presets", "splash"]);

function isThemeSection(value: string): value is ThemeSection {
  return THEME_SECTIONS.has(value);
}

export function PhoneThemeApp({
  draft,
  onDraftChange,
  onApply,
  onClose,
  onNotice,
  widgets,
  onWidgetsChange,
  onDesktopThemeChange,
  pageIcons,
  iconSkins,
  wallpaperStyle,
}: PhoneThemeAppProps) {
  const [section, setSection] = useState<ThemeSection>(() => {
    if (typeof window !== "undefined") {
      const pending = sessionStorage.getItem("mascot-theme-section");
      if (pending) {
        sessionStorage.removeItem("mascot-theme-section");
        return isThemeSection(pending) ? pending : "menu";
      }
    }
    return "menu";
  });
  const [showStatusBarAdjust, setShowStatusBarAdjust] = useState(false);
  const [systemBarShown, setSystemBarShown] = useState(() => typeof document !== "undefined" && readPwaDisplayPreference(document.cookie) === "standalone");
  const [showTextAdjust, setShowTextAdjust] = useState(false);
  const [showThemeTransfer, setShowThemeTransfer] = useState(false);
  const [themeTransferBusy, setThemeTransferBusy] = useState(false);
  const [confirmThemeReset, setConfirmThemeReset] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  const statusBarTop = Number(draft.cssOverrides["--status-bar-top"]?.replace("px", "") || "12");
  const islandHidden = draft.cssOverrides["--status-island-visibility"] === "hidden";

  const handleExportTheme = useCallback(async () => {
    setThemeTransferBusy(true);
    try {
      const result = await createThemePackageBlob({
        themeProfile: draft,
        iconLayout: pageIcons,
        widgets
      });
      const { downloadFile } = await import("@/lib/download-utils");
      await downloadFile(result.blob, result.fileName);
      setShowThemeTransfer(false);
      onNotice(`已导出主题包：${result.summary.assetCount} 个资源，${result.summary.widgetCount} 个桌面组件。`);
    } catch (error) {
      console.error(error);
      onNotice(error instanceof Error ? error.message : "主题导出失败");
    } finally {
      setThemeTransferBusy(false);
    }
  }, [draft, onNotice, pageIcons, widgets]);

  const handleImportFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    setThemeTransferBusy(true);
    try {
      const result = await installThemePackageFile(file);
      onDesktopThemeChange({ widgets: result.widgets, iconLayout: result.iconLayout, dock: result.dock, folders: result.folders });
      await onApply(result.themeProfile);
      onDraftChange(result.themeProfile);
      setShowThemeTransfer(false);
      onNotice(`已导入主题包：${result.summary.assetCount} 个资源，${result.summary.widgetCount} 个桌面组件。`);
    } catch (error) {
      console.error(error);
      onNotice(error instanceof Error ? error.message : "主题导入失败");
    } finally {
      setThemeTransferBusy(false);
    }
  }, [onApply, onDesktopThemeChange, onDraftChange, onNotice]);

  const handleResetTheme = useCallback(async () => {
    setThemeTransferBusy(true);
    try {
      const result = await resetThemePackageState();
      onDesktopThemeChange({ widgets: result.widgets, iconLayout: result.iconLayout, dock: result.dock, folders: result.folders });
      await onApply(result.themeProfile);
      onDraftChange(result.themeProfile);
      setConfirmThemeReset(false);
      onNotice("已恢复默认外观，壁纸库、自定义组件和自定义 App 已保留。");
    } catch (error) {
      console.error(error);
      onNotice(error instanceof Error ? error.message : "恢复默认失败");
    } finally {
      setThemeTransferBusy(false);
    }
  }, [onApply, onDesktopThemeChange, onDraftChange, onNotice]);

  function handleBack() {
    if (section === "menu") {
      onClose();
    } else {
      setSection("menu");
    }
  }

  const title = section === "menu" ? "\u5916\u89C2" : SECTION_TITLES[section];

  return (
    <PageShell title={title} onBack={handleBack}>
        {section === "menu" ? (
          <div className="page-menu appearance-main-menu">
            {/* Section 0: 外观预设 — 单张通栏卡 */}
            <div>
              <h3 className="appearance-menu-section-title">Presets</h3>
              <div className="menu-group mt-2.5">
                {MENU_ITEMS.filter(item => item.section === "presets").map((item) => (
                  <button key={item.section} className="menu-item" type="button" onClick={() => setSection("presets")}>
                    <span className="card-icon card-icon-glass"><GlassIcon name={item.glass} /></span>
                    <span className="menu-label appearance-menu-item-label">{item.label}</span>
                    <span className="ts-11 text-[var(--c-text)] ml-auto mr-1">{item.desc}</span>
                    <span className="menu-right"><IconChevronRight /></span>
                  </button>
                ))}
              </div>
            </div>

            {/* Section 1: 外观定制 — 2x2 card grid */}
            <div>
              <h3 className="appearance-menu-section-title">Appearance</h3>
              <div className="card-grid mt-2.5">
                {MENU_ITEMS.filter(item => ["palette", "wallpaper", "icons", "widgets"].includes(item.section)).map((item) => (
                  <button
                    key={item.section}
                    className="app-card card-card"
                    type="button"
                    onClick={() => {
                      if (item.section !== "transfer" && item.section !== "reset") {
                        setSection(item.section);
                      }
                    }}
                  >
                    <span className="card-icon card-icon-glass">
                      <GlassIcon name={item.glass} />
                    </span>
                    <span className="card-card-body">
                      <span className="card-label">{item.label}</span>
                      <span className="card-desc">{item.desc}</span>
                    </span>
                    <span className="card-card-chevron" aria-hidden="true"><IconChevronRight /></span>
                  </button>
                ))}
              </div>
            </div>

            {/* Section 2: 系统设置 — Glass list group (has toggle) */}
            <div>
              <h3 className="appearance-menu-section-title">System Settings</h3>
              <div className="menu-group mt-2.5">
                {/* 状态栏开关 + 位置调节 */}
                {(() => {
                  const caseItem = MENU_ITEMS.find(i => i.section === "case")!;
                  return (
                    <div className="menu-item cursor-pointer" onClick={() => setShowStatusBarAdjust(true)}>
                      <span className="card-icon card-icon-glass"><GlassIcon name={caseItem.glass} /></span>
                      <span className="menu-label appearance-menu-item-label">{caseItem.label}</span>
                      <label
                        className="block w-10 h-[22px] cursor-pointer relative shrink-0 ml-auto"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={!draft.hideTopBar}
                          onChange={(e) => { const next = { ...draft, hideTopBar: !e.target.checked }; onDraftChange(next); onApply(next); }}
                          className="w-full h-full rounded-[11px] m-0 outline-none"
                          style={{
                            appearance: "none",
                            backgroundColor: !draft.hideTopBar ? "var(--c-success)" : "var(--c-page-body-bg)",
                            transition: "0.2s",
                          }}
                        />
                        <div className="absolute w-[18px] h-[18px] bg-white rounded-full top-[2px] pointer-events-none" style={{
                          left: !draft.hideTopBar ? 20 : 2,
                          transition: "0.2s",
                          boxShadow: "0 2px 4px rgba(0,0,0,0.15)",
                        }} />
                      </label>
                    </div>
                  );
                })()}
                {MENU_ITEMS.filter(item => ["text", "splash"].includes(item.section)).map((item) => (
                  <button
                    key={item.section}
                    className="menu-item"
                    type="button"
                    onClick={() => (item.section === "splash" ? setSection("splash") : setShowTextAdjust(true))}
                  >
                    <span className="card-icon card-icon-glass">
                      <GlassIcon name={item.glass} />
                    </span>
                    <span className="menu-label appearance-menu-item-label">{item.label}</span>
                    <span className="menu-right">
                      <IconChevronRight />
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Section 3: 高级 — Featured card for CSS */}
            {(() => {
              const cssItem = MENU_ITEMS.find(i => i.section === "css")!;
              return (
                <div>
                  <h3 className="appearance-menu-section-title">Advanced</h3>
                  <button
                    className="app-card card-featured mt-2.5"
                    type="button"
                    onClick={() => setSection("css")}
                  >
                    <span className="card-icon card-icon-glass">
                      <GlassIcon name={cssItem.glass} />
                    </span>
                    <div className="card-featured-body">
                      <div className="card-featured-label">{cssItem.label}</div>
                      <div className="card-featured-desc">{cssItem.desc}</div>
                    </div>
                    <span className="card-featured-chevron"><IconChevronRight /></span>
                  </button>
                </div>
              );
            })()}

            {/* Section 4: 系统 — 2-column card grid */}
            <div>
              <h3 className="appearance-menu-section-title">System</h3>
              <div className="card-grid mt-2.5">
                {MENU_ITEMS.filter(item => ["transfer", "reset"].includes(item.section)).map((item) => (
                  <button
                    key={item.section}
                    className="app-card card-card"
                    type="button"
                    onClick={() => {
                      if (item.section === "transfer") {
                        setShowThemeTransfer(true);
                      } else {
                        setConfirmThemeReset(true);
                      }
                    }}
                  >
                    <span className="card-icon card-icon-glass">
                      <GlassIcon name={item.glass} />
                    </span>
                    <span className="card-card-body">
                      <span className="card-label">{item.label}</span>
                      {item.desc && <span className="card-desc">{item.desc}</span>}
                    </span>
                    <span className="card-card-chevron" aria-hidden="true"><IconChevronRight /></span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : section === "wallpaper" ? (
          <WallpaperPage
            draft={draft}
            onDraftChange={onDraftChange}
            onApply={onApply}
            onNotice={onNotice}
          />
        ) : section === "widgets" ? (
          <WidgetManagerPage
            widgets={widgets}
            onWidgetsChange={onWidgetsChange}
            pageIcons={pageIcons}
            iconSkins={iconSkins}
            wallpaperStyle={wallpaperStyle}
          />
        ) : section === "palette" ? (
          <PalettePresetPage draft={draft} onDraftChange={onDraftChange} onApply={onApply} onNotice={onNotice} />
        ) : section === "css" ? (
          <GlobalCSSPage draft={draft} onDraftChange={onDraftChange} onApply={onApply} onNotice={onNotice} />
        ) : section === "icons" ? (
          <IconSkinPage draft={draft} onDraftChange={onDraftChange} onApply={onApply} onNotice={onNotice} />
        ) : section === "presets" ? (
          <AppearancePresetPage
            draft={draft}
            pageIcons={pageIcons}
            widgets={widgets}
            onDesktopThemeChange={onDesktopThemeChange}
            onApply={onApply}
            onDraftChange={onDraftChange}
            onNotice={onNotice}
          />
        ) : section === "splash" ? (
          <SplashVariantPage onNotice={onNotice} />
        ) : (
          <div className="flex-1 overflow-y-auto items-start justify-center flex">
            <p className="ts-14 text-[var(--c-icon)]">{"\u300C"}{SECTION_TITLES[section]}{"\u300D\u529F\u80FD\u5F00\u53D1\u4E2D\u2026"}</p>
          </div>
        )}
      {/* 不限定 accept：.ai-theme 是自定义后缀，iOS「文件」选择器会把
          没有注册 UTI 的类型置灰导致选不中。放开后由 installThemePackageFile
          校验包内 manifest.json，非法文件照样会被拒。 */}
      <input
        ref={importFileRef}
        type="file"
        className="hidden"
        onChange={handleImportFileChange}
      />
      {showThemeTransfer && createPortal(
        <ContentDialog
          title="主题导入 / 导出"
          confirmLabel={undefined}
          cancelLabel="关闭"
          onConfirm={() => setShowThemeTransfer(false)}
          onCancel={() => {
            if (!themeTransferBusy) setShowThemeTransfer(false);
          }}
        >
          <div className="flex flex-col gap-4">
            <p className="ts-13 leading-relaxed text-[var(--c-text)]">
              主题包会包含主题色、壁纸、图标、桌面组件、自定义组件，以及桌面图标和组件位置。
            </p>
            <div className="grid grid-cols-2 gap-8 py-1">
              <button
                type="button"
                className="inline-flex min-h-[74px] flex-col items-center justify-center gap-2 bg-transparent px-2 text-xs font-bold text-[var(--c-text-title)] transition-all active:scale-95 disabled:opacity-40"
                onClick={() => importFileRef.current?.click()}
                disabled={themeTransferBusy}
              >
                <span className="card-icon" style={menuIconStyle(BINDING_ACCENTS.api)}>
                  <Upload size={20} strokeWidth={1.75} />
                </span>
                <span>导入</span>
              </button>
              <button
                type="button"
                className="inline-flex min-h-[74px] flex-col items-center justify-center gap-2 bg-transparent px-2 text-xs font-bold text-[var(--c-text-title)] transition-all active:scale-95 disabled:opacity-40"
                onClick={handleExportTheme}
                disabled={themeTransferBusy}
              >
                <span className="card-icon" style={menuIconStyle(BINDING_ACCENTS.embedding)}>
                  <Download size={20} strokeWidth={1.75} />
                </span>
                <span>导出</span>
              </button>
            </div>
          </div>
        </ContentDialog>,
        document.querySelector(".phone-shell") ?? document.body
      )}
      {confirmThemeReset && (
        <ConfirmDialog
          title="恢复默认外观？"
          message="将恢复默认主题色、当前壁纸、图标、桌面组件和桌面位置；已导入的壁纸库和自定义组件会保留，但不会继续应用在桌面上。已安装的自定义 App 图标会自动排回桌面空位。"
          icon={AlertCircle}
          variant="danger"
          confirmLabel={themeTransferBusy ? "恢复中" : "恢复默认"}
          cancelLabel="取消"
          onConfirm={themeTransferBusy ? () => {} : handleResetTheme}
          onCancel={() => {
            if (!themeTransferBusy) setConfirmThemeReset(false);
          }}
        />
      )}
      {showStatusBarAdjust && createPortal(
        <ContentDialog
          title={"状态栏"}
          confirmLabel={"确定"}
          cancelLabel={"重置"}
          onConfirm={() => setShowStatusBarAdjust(false)}
          onCancel={() => {
            const next = { ...draft, cssOverrides: { ...draft.cssOverrides } };
            delete next.cssOverrides["--status-bar-top"];
            onDraftChange(next);
            onApply(next);
            setShowStatusBarAdjust(false);
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-text)" }}>{"显示系统状态栏"}</span>
              <label className="block w-10 h-[22px] cursor-pointer relative shrink-0" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={systemBarShown}
                  onChange={(e) => {
                    const shown = e.target.checked;
                    setSystemBarShown(shown);
                    writePwaDisplayPreference(shown ? "standalone" : "fullscreen");
                    if (shown && document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
                    onNotice(shown ? "已开启系统状态栏，重新添加到桌面后完全生效" : "已恢复沉浸全屏，重新添加到桌面后完全生效");
                  }}
                  className="w-full h-full rounded-[11px] m-0 outline-none"
                  style={{ appearance: "none", backgroundColor: systemBarShown ? "var(--c-success)" : "var(--c-page-body-bg)", border: systemBarShown ? "none" : "1px solid var(--c-input-border)", transition: "0.2s" }}
                />
                <div className="absolute w-[18px] h-[18px] bg-white rounded-full top-[2px] pointer-events-none" style={{ left: systemBarShown ? 20 : 2, transition: "0.2s", boxShadow: "0 2px 4px rgba(0,0,0,0.15)" }} />
              </label>
            </div>
            <p style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-icon)", lineHeight: 1.4 }}>
              {"显示手机系统自己的状态栏（时间/电量/通知），退出沉浸全屏，安卓不再反复弹全屏提示。开启后本页的虚拟状态栏不再显示；已装到桌面的需删除后重新「添加到主屏幕」才完全生效。"}
            </p>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-text)" }}>{"顶部偏移"}</span>
              <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-text-title)", fontWeight: 600 }}>{statusBarTop}px</span>
            </div>
            <input
              type="range"
              min={-40}
              max={40}
              step={1}
              value={statusBarTop}
              onChange={(e) => {
                const val = Number(e.target.value);
                const next = { ...draft, cssOverrides: { ...draft.cssOverrides, "--status-bar-top": `${val}px` } };
                onDraftChange(next);
                onApply(next);
              }}
              className="ui-slider"
              data-ui="slider"
            />
            <p style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-icon)", lineHeight: 1.4 }}>
              {"调节状态栏文字和图标的垂直位置，适配不同设备。可设为负值上移（顶部空间偏大的浏览器如 Edge 适用）。点「重置」恢复默认值。"}
            </p>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
              <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-text)" }}>{"隐藏灵动岛"}</span>
              <label
                className="block w-10 h-[22px] cursor-pointer relative shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={islandHidden}
                  onChange={(e) => {
                    const next = { ...draft, cssOverrides: { ...draft.cssOverrides, "--status-island-visibility": e.target.checked ? "hidden" : "visible" } };
                    onDraftChange(next);
                    onApply(next);
                  }}
                  className="w-full h-full rounded-[11px] m-0 outline-none"
                  style={{ appearance: "none", backgroundColor: islandHidden ? "var(--c-success)" : "var(--c-page-body-bg)", border: islandHidden ? "none" : "1px solid var(--c-input-border)", transition: "0.2s" }}
                />
                <div className="absolute w-[18px] h-[18px] bg-white rounded-full top-[2px] pointer-events-none" style={{ left: islandHidden ? 20 : 2, transition: "0.2s", boxShadow: "0 2px 4px rgba(0,0,0,0.15)" }} />
              </label>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
              <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-text)" }}>{"状态栏占位上移"}</span>
              <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-text-title)", fontWeight: 600 }}>{draft.statusBarDropPx ?? 0}px</span>
            </div>
            <input
              type="range"
              min={0}
              max={120}
              step={1}
              value={draft.statusBarDropPx ?? 0}
              onChange={(e) => {
                const next = { ...draft, statusBarDropPx: Number(e.target.value) };
                onDraftChange(next);
                onApply(next);
              }}
              className="ui-slider"
              data-ui="slider"
            />
            <p style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-icon)", lineHeight: 1.4 }}>
              {"安卓部分浏览器不能全屏（底部被真实状态栏顶出屏幕）时调大：把整块画面上移、裁掉顶部状态栏占位，让底部栏回到屏幕内。调到刚好铺满即可（约等于真实状态栏高度）。iOS 能正常全屏，保持 0。"}
            </p>
          </div>
        </ContentDialog>,
        document.querySelector(".phone-shell") ?? document.body
      )}
      {showTextAdjust && createPortal(
        <ContentDialog
          title={"文字"}
          confirmLabel={"确定"}
          cancelLabel={undefined}
          onConfirm={() => setShowTextAdjust(false)}
          onCancel={() => setShowTextAdjust(false)}
        >
          <TextScalePage
            draft={draft}
            onDraftChange={onDraftChange}
            onApply={onApply}
            onNotice={onNotice}
            compact
          />
        </ContentDialog>,
        document.querySelector(".phone-shell") ?? document.body
      )}
    </PageShell>
  );
}

/* ══════════════════════════════════════════
   Palette (Seed Color) Editor
   ══════════════════════════════════════════ */

type ColorItem = { key: string; label: string; defaultValue: string };
const COLOR_ITEMS: ColorItem[] = [
  { key: "--c-header-bg", label: "标题栏", defaultValue: "#FFFFFF" },
  { key: "--c-page-body-bg", label: "内容区", defaultValue: "#F1F2F6" },
  { key: "--c-card", label: "卡片", defaultValue: "rgba(255, 255, 255, 0.7)" },
  { key: "--c-card-border", label: "卡片边框", defaultValue: "#E0E0E0" },
  { key: "--c-panel", label: "面板", defaultValue: "#FFFFFF" },
  { key: "--c-panel-border", label: "面板边框", defaultValue: "#D9DADB" },
  { key: "--c-input", label: "输入框", defaultValue: "#F2F3F5" },
  { key: "--c-input-border", label: "输入框边框", defaultValue: "rgba(224, 226, 229, 0)" },
];

/** Parse any CSS color string into { hex, alpha } */
function parseColorAlpha(val: string): { hex: string; alpha: number } {
  const rgbaMatch = val.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/);
  if (rgbaMatch) {
    const r = Number(rgbaMatch[1]), g = Number(rgbaMatch[2]), b = Number(rgbaMatch[3]);
    const a = rgbaMatch[4] !== undefined ? Number(rgbaMatch[4]) : 1;
    const hex = `#${[r, g, b].map(c => c.toString(16).padStart(2, "0")).join("")}`;
    return { hex, alpha: a };
  }
  if (val.startsWith("#") && (val.length === 4 || val.length === 7 || val.length === 9)) {
    if (val.length === 9) {
      const a = parseInt(val.slice(7, 9), 16) / 255;
      return { hex: val.slice(0, 7), alpha: a };
    }
    return { hex: val.length === 4 ? `#${val[1]}${val[1]}${val[2]}${val[2]}${val[3]}${val[3]}` : val, alpha: 1 };
  }
  return { hex: "#000000", alpha: 1 };
}

/** Build CSS color string from hex + alpha */
function buildColor(hex: string, alpha: number): string {
  if (alpha >= 1) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ── 外观预设：整套外观存多份，一键切换 ─────────────────
function AppearancePresetPage({
  draft,
  pageIcons,
  widgets,
  onDesktopThemeChange,
  onApply,
  onDraftChange,
  onNotice,
}: {
  draft: ThemeProfile;
  pageIcons: DesktopIconLayout;
  widgets: WidgetInstance[];
  onDesktopThemeChange: PhoneThemeAppProps["onDesktopThemeChange"];
  onApply: (next: ThemeProfile) => Promise<void> | void;
  onDraftChange: (next: ThemeProfile) => void;
  onNotice: (text: string) => void;
}) {
  const [presets, setPresets] = useState<AppearancePreset[]>(() => loadAppearancePresets());
  const [newName, setNewName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AppearancePreset | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState<AppearancePreset | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  useEffect(() => {
    const ids = presets.map((p) => p.themeProfile.wallpaperAssetId).filter((id): id is string => Boolean(id));
    if (!ids.length) return;
    let cancelled = false;
    void getThemeAssetMap(ids).then((map) => { if (!cancelled) setThumbs(map); });
    return () => { cancelled = true; };
  }, [presets]);

  const refresh = () => setPresets(loadAppearancePresets());

  const handleSave = () => {
    try {
      const preset = saveAppearancePreset(newName, { themeProfile: draft, iconLayout: pageIcons, widgets });
      setNewName("");
      refresh();
      onNotice(`已保存预设「${preset.name}」`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "保存失败");
    }
  };

  const handleApply = async (preset: AppearancePreset) => {
    setBusyId(preset.id);
    try {
      // 与主题包导入同一条落地路径：桌面布局/组件/dock/文件夹 → DIY 模板 → 主题档案
      onDesktopThemeChange({ widgets: preset.desktop.widgets, iconLayout: preset.desktop.iconLayout, dock: preset.desktop.dock, folders: preset.desktop.folders });
      saveDIYTemplates(preset.desktop.diyTemplates);
      notifyDesktopWidgetsChanged();
      await onApply(preset.themeProfile);
      onDraftChange(preset.themeProfile);
      onNotice(`已切换到「${preset.name}」`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "切换失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleOverwrite = (preset: AppearancePreset) => {
    setConfirmOverwrite(null);
    const next = overwriteAppearancePreset(preset.id, { themeProfile: draft, iconLayout: pageIcons, widgets });
    refresh();
    onNotice(next ? `已用当前外观更新「${next.name}」` : "预设已不存在");
  };

  const handleRename = () => {
    if (!renaming) return;
    renameAppearancePreset(renaming.id, renaming.name);
    setRenaming(null);
    refresh();
  };

  const handleDelete = (preset: AppearancePreset) => {
    setConfirmDelete(null);
    deleteAppearancePreset(preset.id);
    refresh();
    onNotice(`已删除「${preset.name}」，它用过的壁纸和图标仍在素材库里`);
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <div className="theme-section-page" data-bottom-reserve>
      <div className="rounded-xl bg-[var(--c-card)] border border-[var(--c-card-border)] p-3 flex flex-col gap-2">
        <div className="ts-12 font-medium">把当前外观存为预设</div>
        <div className="ts-11 text-[var(--c-text)] leading-relaxed">包含主题色、壁纸、图标、字体、状态栏、CSS 变量、桌面组件与图标位置、dock 和文件夹。壁纸等素材只记引用，不会重复占空间。</div>
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={`预设 ${presets.length + 1}`}
            maxLength={24}
            className="flex-1 min-w-0 h-9 rounded-lg border border-[var(--c-card-border)] bg-[var(--c-page-body-bg)] px-3 ts-12 outline-none"
          />
          <button
            type="button"
            className="inline-flex h-9 items-center gap-1.5 rounded-[18px] bg-black px-4 text-xs font-bold text-white active:scale-95 disabled:opacity-40"
            onClick={handleSave}
            disabled={presets.length >= APPEARANCE_PRESET_MAX}
          >
            <Save size={14} strokeWidth={1.8} />
            保存
          </button>
        </div>
      </div>

      {presets.length === 0 ? (
        <p className="ts-12 text-[var(--c-text)] text-center mt-8">还没有预设。先把外观调成你喜欢的样子，回来存一份。</p>
      ) : (
        <div className="flex flex-col gap-2 mt-3">
          {presets.map((preset) => {
            const accent = preset.themeProfile.cssOverrides["--c-icon-active"] || preset.themeProfile.cssOverrides["--c-success"] || "var(--c-icon-active)";
            const thumb = preset.themeProfile.wallpaperAssetId ? thumbs[preset.themeProfile.wallpaperAssetId] : undefined;
            const busy = busyId === preset.id;
            return (
              <div key={preset.id} className="rounded-xl bg-[var(--c-card)] border border-[var(--c-card-border)] p-2.5 flex gap-3 items-center">
                <div
                  className="w-12 h-[72px] rounded-lg overflow-hidden shrink-0 border border-[var(--c-card-border)]"
                  style={{ background: thumb ? `url(${thumb}) center/cover` : `linear-gradient(160deg, ${accent}, var(--c-page-body-bg))` }}
                />
                <div className="flex-1 min-w-0">
                  {renaming?.id === preset.id ? (
                    <div className="flex gap-1.5 items-center">
                      <input
                        autoFocus
                        type="text"
                        value={renaming.name}
                        maxLength={24}
                        onChange={(e) => setRenaming({ id: preset.id, name: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") setRenaming(null); }}
                        className="flex-1 min-w-0 h-8 rounded-lg border border-[var(--c-card-border)] bg-[var(--c-page-body-bg)] px-2 ts-12 outline-none"
                      />
                      <button type="button" className="w-8 h-8 grid place-items-center rounded-lg bg-black text-white" onClick={handleRename} aria-label="确定"><Check size={14} /></button>
                    </div>
                  ) : (
                    <div className="ts-13 font-semibold truncate">{preset.name}</div>
                  )}
                  <div className="ts-10 text-[var(--c-text)] truncate mt-0.5">{describeAppearancePreset(preset)}</div>
                  <div className="ts-10 text-[var(--c-text)] opacity-70 mt-0.5">更新于 {formatTime(preset.updatedAt)}</div>
                  <div className="flex gap-1 mt-1.5">
                    <button type="button" className="w-7 h-7 grid place-items-center rounded-md text-[var(--c-text)] active:bg-[var(--c-page-body-bg)]" title="重命名" aria-label="重命名" onClick={() => setRenaming({ id: preset.id, name: preset.name })}><Pencil size={13} /></button>
                    <button type="button" className="w-7 h-7 grid place-items-center rounded-md text-[var(--c-text)] active:bg-[var(--c-page-body-bg)]" title="用当前外观覆盖" aria-label="用当前外观覆盖" onClick={() => setConfirmOverwrite(preset)}><Save size={13} /></button>
                    <button type="button" className="w-7 h-7 grid place-items-center rounded-md text-[var(--c-danger,#d0564b)] active:bg-[var(--c-page-body-bg)]" title="删除" aria-label="删除" onClick={() => setConfirmDelete(preset)}><Trash2 size={13} /></button>
                  </div>
                </div>
                <button
                  type="button"
                  className="inline-flex h-9 items-center rounded-[18px] bg-black px-4 text-xs font-bold text-white active:scale-95 disabled:opacity-40 shrink-0"
                  onClick={() => handleApply(preset)}
                  disabled={busyId !== null}
                >
                  {busy ? "切换中…" : "应用"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`删除预设「${confirmDelete.name}」？`}
          message="只删除这份预设记录，当前外观和素材库都不受影响。"
          confirmLabel="删除"
          cancelLabel="取消"
          variant="danger"
          icon={Trash2}
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {confirmOverwrite && (
        <ConfirmDialog
          title={`用当前外观覆盖「${confirmOverwrite.name}」？`}
          message="这套预设原来保存的内容会被替换成现在的外观。"
          icon={Save}
          confirmLabel="覆盖"
          cancelLabel="取消"
          onConfirm={() => handleOverwrite(confirmOverwrite)}
          onCancel={() => setConfirmOverwrite(null)}
        />
      )}
    </div>
  );
}

// ── 开屏动画：内置几套 + 自己的代码，选一套下次进入生效 ─────────────
function SplashVariantPage({ onNotice }: { onNotice: (text: string) => void }) {
  const [selected, setSelected] = useState<SplashVariantId>(() => readSplashVariant());
  const [previewing, setPreviewing] = useState<SplashVariantId | null>(null);
  const [customs, setCustoms] = useState<CustomSplash[]>(() => loadCustomSplashes());
  const [editor, setEditor] = useState<{ id?: string; name: string; code: string } | null>(null);
  const [confirmDeleteCustom, setConfirmDeleteCustom] = useState<CustomSplash | null>(null);
  const customFileRef = useRef<HTMLInputElement | null>(null);

  const labelOf = (id: SplashVariantId) =>
    SPLASH_VARIANTS.find((v) => v.id === id)?.label ?? customs.find((c) => customSplashVariantId(c.id) === id)?.name ?? id;

  const choose = (id: SplashVariantId) => {
    writeSplashVariant(id);
    setSelected(id);
    onNotice(id === "none" ? "已关闭开屏，下次打开直接进桌面" : `开屏动画已切换为「${labelOf(id)}」，下次打开生效`);
  };

  const handleSaveCustom = () => {
    if (!editor) return;
    try {
      const saved = saveCustomSplash(editor);
      setCustoms(loadCustomSplashes());
      setEditor(null);
      onNotice(`已保存「${saved.name}」`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "保存失败");
    }
  };

  const handleDeleteCustom = (item: CustomSplash) => {
    setConfirmDeleteCustom(null);
    deleteCustomSplash(item.id);
    setCustoms(loadCustomSplashes());
    setSelected(readSplashVariant());
    onNotice(`已删除「${item.name}」`);
  };

  const handleCustomFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const code = typeof reader.result === "string" ? reader.result : "";
      setEditor((prev) => ({ id: prev?.id, name: prev?.name || file.name.replace(/\.[^.]+$/, ""), code }));
    };
    reader.readAsText(file);
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const formatChars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K 字符` : `${n} 字符`);

  const renderUseButton = (id: SplashVariantId) => {
    const active = selected === id;
    return (
      <button
        type="button"
        className={`h-8 rounded-[16px] px-4 text-xs font-bold active:scale-95 ${active ? "bg-[var(--c-page-body-bg)] text-[var(--c-text)]" : "bg-black text-white"}`}
        onClick={() => choose(id)}
        disabled={active}
      >
        {active ? "使用中" : "使用"}
      </button>
    );
  };

  return (
    <div className="theme-section-page" data-bottom-reserve>
      <div className="ts-11 text-[var(--c-text)] leading-relaxed mb-3">点卡片可以预览，点「使用」保存。选择只存在这台设备的浏览器里，会随备份带走。</div>
      <div className="grid grid-cols-2 gap-3">
        {SPLASH_VARIANTS.map((variant) => {
          const active = selected === variant.id;
          return (
            <div key={variant.id} className="rounded-xl bg-[var(--c-card)] border p-2 flex flex-col gap-2" style={{ borderColor: active ? "var(--c-icon-active)" : "var(--c-card-border)" }}>
              <button type="button" className="splash-preview-btn" onClick={() => setPreviewing(variant.id)} aria-label={`预览${variant.label}`}>
                {variant.id === "none" ? (
                  <div className="splash-preview-box grid place-items-center ts-11 text-[var(--c-text)]">直接进桌面</div>
                ) : (
                  <SplashPreview variant={variant.id} />
                )}
              </button>
              <div className="ts-12 font-semibold flex items-center gap-1">
                {variant.label}
                {active && <Check size={13} className="text-[var(--c-icon-active)]" />}
              </div>
              <div className="ts-10 text-[var(--c-text)] leading-snug min-h-[2.4em]">{variant.desc}</div>
              {renderUseButton(variant.id)}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between mt-5 mb-2">
        <div className="ts-13 font-semibold">自定义开屏</div>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1 rounded-[16px] bg-black px-3 text-xs font-bold text-white active:scale-95 disabled:opacity-40"
          onClick={() => setEditor({ name: "", code: "" })}
          disabled={customs.length >= CUSTOM_SPLASH_MAX}
        >
          <Plus size={14} strokeWidth={2} />
          新建
        </button>
      </div>
      <div className="ts-11 text-[var(--c-text)] leading-relaxed mb-2">贴一段完整 HTML（可以带 style 和 script），它会在开屏那块 390×844 的画面里独立运行，和换消息主题一样，存几套随时切。</div>
      {customs.length === 0 ? (
        <div className="rounded-xl bg-[var(--c-card)] border border-[var(--c-card-border)] p-4 ts-11 text-[var(--c-text)] text-center">还没有自定义开屏</div>
      ) : (
        <div className="flex flex-col gap-2">
          {customs.map((item) => {
            const id = customSplashVariantId(item.id);
            const active = selected === id;
            return (
              <div key={item.id} className="rounded-xl bg-[var(--c-card)] border p-2.5 flex gap-3 items-center" style={{ borderColor: active ? "var(--c-icon-active)" : "var(--c-card-border)" }}>
                <button type="button" className="splash-preview-btn" style={{ width: 48, flex: "none" }} onClick={() => setPreviewing(id)} aria-label={`预览${item.name}`}>
                  <SplashPreview variant={id} />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="ts-13 font-semibold truncate flex items-center gap-1">
                    {item.name}
                    {active && <Check size={13} className="text-[var(--c-icon-active)]" />}
                  </div>
                  <div className="ts-10 text-[var(--c-text)] opacity-70 mt-0.5">{formatChars(item.code.length)} · 更新于 {formatTime(item.updatedAt)}</div>
                  <div className="flex gap-1 mt-1.5">
                    <button type="button" className="w-7 h-7 grid place-items-center rounded-md text-[var(--c-text)] active:bg-[var(--c-page-body-bg)]" title="编辑代码" aria-label="编辑代码" onClick={() => setEditor({ id: item.id, name: item.name, code: item.code })}><Pencil size={13} /></button>
                    <button type="button" className="w-7 h-7 grid place-items-center rounded-md text-[var(--c-danger,#d0564b)] active:bg-[var(--c-page-body-bg)]" title="删除" aria-label="删除" onClick={() => setConfirmDeleteCustom(item)}><Trash2 size={13} /></button>
                  </div>
                </div>
                {renderUseButton(id)}
              </div>
            );
          })}
        </div>
      )}

      {previewing && previewing !== "none" && createPortal(
        <div className="absolute inset-0 z-[60] bg-[#F1F2F6]" onClick={() => setPreviewing(null)}>
          <SplashVariant variant={previewing} />
          <div className="absolute left-0 right-0 bottom-6 text-center ts-11 text-black/50 z-[5] pointer-events-none">点击任意处返回</div>
          <button type="button" className="absolute inset-0 z-[4] bg-transparent border-0" aria-label="返回" onClick={() => setPreviewing(null)} />
        </div>,
        document.querySelector(".phone-shell") ?? document.body,
      )}
      {editor && createPortal(
        <ContentDialog
          title={editor.id ? "编辑自定义开屏" : "新建自定义开屏"}
          confirmLabel="保存"
          cancelLabel="取消"
          confirmDisabled={!editor.code.trim()}
          onConfirm={handleSaveCustom}
          onCancel={() => setEditor(null)}
        >
          <div className="flex flex-col gap-2">
            <input
              type="text"
              value={editor.name}
              onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              placeholder="名字"
              maxLength={24}
              className="h-9 rounded-lg border border-[var(--c-card-border)] bg-[var(--c-page-body-bg)] px-3 ts-12 outline-none"
            />
            <textarea
              value={editor.code}
              onChange={(e) => setEditor({ ...editor, code: e.target.value })}
              placeholder={"<style>body{background:#111}</style>\n<div id=\"logo\">float</div>\n<script>/* 你的动画 */</script>"}
              spellCheck={false}
              className="h-[38vh] rounded-lg border border-[var(--c-card-border)] bg-[var(--c-page-body-bg)] p-2.5 ts-11 font-mono leading-relaxed outline-none resize-none"
            />
            <div className="flex items-center justify-between">
              <button type="button" className="ts-11 text-[var(--c-icon-active)] bg-transparent border-0 p-0" onClick={() => customFileRef.current?.click()}>从 .html 文件导入</button>
              <span className="ts-10 text-[var(--c-text)] opacity-70">{formatChars(editor.code.length)}</span>
            </div>
            <input ref={customFileRef} type="file" accept=".html,.htm,text/html" className="hidden" onChange={handleCustomFile} />
            <div className="ts-10 text-[var(--c-text)] leading-relaxed">代码在沙盒里运行，碰不到手机的数据。没写 &lt;html&gt; 会自动补上无边距的外壳。图片和字体请内嵌为 data URL 或用公网地址。</div>
          </div>
        </ContentDialog>,
        document.querySelector(".phone-shell") ?? document.body,
      )}
      {confirmDeleteCustom && (
        <ConfirmDialog
          title={`删除「${confirmDeleteCustom.name}」？`}
          message="正在使用它的话，开屏会回到默认的「漂浮」。"
          confirmLabel="删除"
          cancelLabel="取消"
          variant="danger"
          icon={Trash2}
          onConfirm={() => handleDeleteCustom(confirmDeleteCustom)}
          onCancel={() => setConfirmDeleteCustom(null)}
        />
      )}
    </div>
  );
}

function PalettePresetPage({
  draft,
  onDraftChange,
  onApply,
  onNotice,
}: {
  draft: ThemeProfile;
  onDraftChange: (next: ThemeProfile) => void;
  onApply: (next: ThemeProfile) => Promise<void> | void;
  onNotice: (text: string) => void;
}) {
  function handleColorChange(key: string, value: string) {
    const newOverrides = { ...draft.cssOverrides };
    if (!value.trim()) {
      delete newOverrides[key];
    } else {
      newOverrides[key] = value.trim();
    }
    const next = normalizeThemeProfile({ ...draft, cssOverrides: newOverrides });
    onDraftChange(next);
  }

  function handleApplyAll() {
    onApply(draft);
    onNotice("主题色已应用");
  }

  function handleReset() {
    const newOverrides = { ...draft.cssOverrides };
    for (const item of COLOR_ITEMS) {
      delete newOverrides[item.key];
    }
    const next = normalizeThemeProfile({ ...draft, cssOverrides: newOverrides });
    onDraftChange(next);
    onApply(next);
    onNotice("已恢复默认颜色");
  }

  const [activeKey, setActiveKey] = useState<string | null>(null);

  return (
    <div className="theme-section-page" data-bottom-reserve>
      <div className="flex flex-col gap-4">
        <div>
          <div className="grid grid-cols-4 gap-2">
            {COLOR_ITEMS.map((seed) => {
              const currentValue = draft.cssOverrides[seed.key] || seed.defaultValue;
              const isActive = activeKey === seed.key;
              return (
                <div key={seed.key} className="flex flex-col items-center cursor-pointer" onClick={() => setActiveKey(isActive ? null : seed.key)}>
                  <div className="relative w-full aspect-square rounded-lg overflow-hidden border-2"
                    style={{
                      backgroundImage: "conic-gradient(#ccc 25%, #fff 25% 50%, #ccc 50% 75%, #fff 75%)",
                      backgroundSize: "8px 8px",
                      borderColor: isActive ? "var(--c-icon-active)" : "var(--c-card-border)",
                    }}>
                    <div className="absolute inset-0" style={{ background: currentValue }} />
                  </div>
                  <div className="ts-10 font-medium mt-1 text-center leading-tight truncate w-full">{seed.label}</div>
                </div>
              );
            })}
          </div>
          {activeKey && (() => {
            const seed = COLOR_ITEMS.find(s => s.key === activeKey);
            if (!seed) return null;
            const currentValue = draft.cssOverrides[seed.key] || seed.defaultValue;
            const { hex, alpha } = parseColorAlpha(currentValue);
            return (
              <div className="mt-3 rounded-xl bg-[var(--c-card)] border border-[var(--c-card-border)] overflow-hidden">
                <label className="relative block w-full h-[120px] cursor-pointer"
                  style={{ backgroundImage: "conic-gradient(#ccc 25%, #fff 25% 50%, #ccc 50% 75%)", backgroundSize: "12px 12px" }}>
                  <div className="absolute inset-0" style={{ background: currentValue }} />
                  <input type="color" value={hex}
                    onChange={(e) => handleColorChange(seed.key, buildColor(e.target.value, alpha))}
                    className="absolute inset-0 opacity-0 cursor-pointer" />
                </label>
                <div className="px-3 py-2.5 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="ts-11 text-[var(--c-text)] flex-shrink-0">透明度</span>
                    <input type="range" min={0} max={100} step="any"
                      value={alpha * 100}
                      onChange={(e) => handleColorChange(seed.key, buildColor(hex, Number(e.target.value) / 100))}
                      className="ui-slider flex-1" />
                    <span className="ui-slider-value">{Math.round(alpha * 100)}%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="ts-12 font-medium">{seed.label}</span>
                    <span className="ts-10 text-[var(--c-text)] font-mono">{seed.key}</span>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-4">
        <button
          type="button"
          className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] border border-black/10 bg-white px-4 text-xs font-bold text-gray-800 shadow-sm transition-all hover:bg-gray-50 hover:shadow-md active:scale-95 focus:outline-none"
          onClick={handleReset}
        >
          <RotateCcw size={15} strokeWidth={1.8} />
          <span>重置</span>
        </button>
        <button
          type="button"
          className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
          onClick={handleApplyAll}
        >
          <PaintBucket size={15} strokeWidth={1.8} />
          <span>应用</span>
        </button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   Global Custom CSS Page
   ══════════════════════════════════════════ */

function TextScalePage({
  draft,
  onDraftChange,
  onApply,
  onNotice,
  compact = false,
}: {
  draft: ThemeProfile;
  onDraftChange: (next: ThemeProfile) => void;
  onApply: (next: ThemeProfile) => Promise<void> | void;
  onNotice: (text: string) => void;
  compact?: boolean;
}) {
  const fontFileRef = useRef<HTMLInputElement>(null);
  const scale = Number(draft.cssOverrides["--app-text-scale"] || "1");
  const pct = Math.round(scale * 100);
  const updateScale = (val: number) => {
    const next = { ...draft, cssOverrides: { ...draft.cssOverrides, "--app-text-scale": String(val) } };
    onDraftChange(next);
    onApply(next);
  };
  const handleFontClear = useCallback(async () => {
    const assetId = draft.fontAssetId;
    const { "--app-font-family": _fontOverride, ...cssOverrides } = draft.cssOverrides;
    const next = normalizeThemeProfile({ ...draft, fontAssetId: null, cssOverrides });
    let cleanupFailed = false;
    try {
      if (assetId && !isThemeAssetReferencedByPresets(assetId)) {
        try {
          await deleteThemeAsset(assetId);
        } catch (err) {
          cleanupFailed = true;
          console.warn("[Font] asset cleanup failed:", err);
        }
      }
      onDraftChange(next);
      await onApply(next);
      onNotice(cleanupFailed ? "已清除上传字体，资源稍后可再清理" : "已清除上传字体");
    } catch (err) {
      console.error("[Font] clear failed:", err);
      onNotice("清除失败：" + String(err));
    }
  }, [draft, onDraftChange, onApply, onNotice]);
  const handleFontUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    try {
      console.log("[Font] uploading:", file.name, file.size, file.type);
      const assetId = await saveThemeAssetFromBlob(file, "font");
      console.log("[Font] saved assetId:", assetId);
      const { "--app-font-family": _fontOverride, ...cssOverrides } = draft.cssOverrides;
      const next = normalizeThemeProfile({ ...draft, fontAssetId: assetId, fontFamily: draft.fontFamily, cssOverrides });
      console.log("[Font] applying theme, fontAssetId:", next.fontAssetId, "fontFamily:", next.fontFamily);
      onDraftChange(next);
      await onApply(next);
      onNotice("字体已上传：" + file.name);
    } catch (err) {
      console.error("[Font] upload failed:", err);
      onNotice("上传失败：" + String(err));
    }
  }, [draft, onDraftChange, onApply, onNotice]);
  return (
    <div className="theme-section-page" style={{ padding: compact ? 0 : "16px 28px 24px" }}>
      {/* 文字缩放 */}
      <div className="wp-sliders">
        <div className="wp-slider-row">
          <label>{"文字缩放"}</label>
          <input
            className="ui-slider"
            type="range"
            min={75}
            max={150}
            step={5}
            value={pct}
            onChange={(e) => updateScale(Number(e.target.value) / 100)}
          />
          <span className="wp-slider-value">{pct}%</span>
        </div>
      </div>

      {/* 字体选择 */}
      <div className="mt-4">
        <p className="ts-13 font-medium mb-8" style={{ color: "var(--c-text-title)" }}>{"字体"}</p>
        {draft.fontAssetId && (
          <div className="mb-2 flex justify-end">
            <button
              type="button"
              className="inline-flex h-8 items-center justify-center gap-1 rounded-full border border-black/10 bg-white/70 px-3 ts-11 font-medium text-[var(--c-text)] shadow-sm transition-all hover:bg-white active:scale-95 focus:outline-none"
              onClick={handleFontClear}
              title="清除上传字体"
            >
              <RotateCcw size={12} strokeWidth={1.8} />
              <span>清除字体</span>
            </button>
          </div>
        )}
        <div className="my-3">
          <button
            type="button"
            className="inline-flex h-10 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
            onClick={() => fontFileRef.current?.click()}
          >
            <Type size={15} strokeWidth={1.8} />
            <span>上传字体</span>
          </button>
        </div>
        <input
          ref={fontFileRef}
          type="file"
          accept=".ttf,.otf,.woff,.woff2"
          className="hidden"
          onChange={handleFontUpload}
        />
      </div>

      <p className="ts-11 text-[var(--c-icon)] leading-relaxed mt-12">
        {"文字缩放：以当前设计字号为 100%，范围 75% ~ 150%。"}
        <br />
        {"字体：上传 .ttf / .otf / .woff2 文件。"}
      </p>
    </div>
  );
}

const GLOBAL_CSS_NODE_ID = "ai-phone-global-custom-css";

function GlobalCSSPage({
  draft,
  onDraftChange,
  onApply,
  onNotice,
}: {
  draft: ThemeProfile;
  onDraftChange: (next: ThemeProfile) => void;
  onApply: (next: ThemeProfile) => Promise<void> | void;
  onNotice: (text: string) => void;
}) {
  const [localCSS, setLocalCSS] = useState(() => {
    // Read latest from storage in case 小卷 updated it
    try {
      const { readThemeProfile } = require("@/lib/theme-storage");
      return readThemeProfile().globalCustomCSS || draft.globalCustomCSS;
    } catch { return draft.globalCustomCSS; }
  });

  const [savedCSS, setSavedCSS] = useState(localCSS);
  const appliedRef = useRef(draft.globalCustomCSS || "");
  appliedRef.current = draft.globalCustomCSS || "";
  // 预览直接改桌面注入的那个 <style>，不碰 draft：别的页面点「应用」时不会把没保存的预览一起存进去
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const node = document.getElementById(GLOBAL_CSS_NODE_ID);
      if (node) node.textContent = localCSS;
    }, 250);
    return () => window.clearTimeout(timer);
  }, [localCSS]);
  useEffect(() => () => {
    const node = document.getElementById(GLOBAL_CSS_NODE_ID);
    if (node) node.textContent = appliedRef.current;
  }, []);

  function handleApply() {
    const next = normalizeThemeProfile({ ...draft, globalCustomCSS: localCSS });
    onDraftChange(next);
    onApply(next);
    appliedRef.current = localCSS;
    setSavedCSS(localCSS);
    onNotice("自定义 CSS 已保存");
  }

  return (
    <div className="theme-section-page">
      <p className="ts-13 text-[var(--c-text)] mb-3 leading-relaxed">
        {"编写自定义 CSS，覆盖 :root 变量或为任意元素添加样式。停手就能看到效果，点「保存并应用」才会保存；不保存直接返回会恢复原样。"}
      </p>
      <textarea
        className="ui-textarea font-mono ts-13 leading-relaxed flex-1"
        style={{ minHeight: 280, resize: "none", scrollbarWidth: "none" }}
        placeholder={'[data-ui="card"] {\n  border-radius: 14px;\n}\n\n.ui-btn {\n  border-radius: 999px;\n}'}
        value={localCSS}
        onChange={(e) => setLocalCSS(e.target.value)}
        spellCheck={false}
      />
      <div className="flex gap-2 mt-3 items-center">
        <CSSSchemeBar target="global" currentCSS={localCSS} onLoad={setLocalCSS} />
        <button type="button" className="ui-btn ui-btn-outline flex-1" onClick={() => setLocalCSS("")}>清除</button>
        <button type="button" className="ui-btn ui-btn-soft-action flex-1" onClick={handleApply}>保存并应用</button>
      </div>
      {localCSS !== savedCSS && <p className="ts-11 text-[var(--c-text)] opacity-60 mt-2">{"预览中 · 还没保存"}</p>}
    </div>
  );
}

/* ══════════════════════════════════════════
   Icon Skin Page
   ══════════════════════════════════════════ */

// 三页桌面 + DOCK 的默认图标全收进来。漏了第三页时，筑境/工坊/资源集市/独家特调
// 这四个图标在外观里根本没有格子，换不了皮肤。
const BUILTIN_ICON_SKIN_IDS: IconId[] = [...PAGE_1_DEFAULT, ...PAGE_2_DEFAULT, ...PAGE_3_DEFAULT, ...DOCK_DEFAULT];

type IconSkinItem = {
  id: DesktopIconId;
  label: string;
  builtinId: IconId | null;
  iconDataUrl?: string;
};

function updateIconSkin(draft: ThemeProfile, iconId: DesktopIconId, assetId: string | null): ThemeProfile {
  const skins = { ...draft.iconSkins };
  if (assetId) skins[iconId] = assetId; else delete skins[iconId];

  const schemes = draft.iconSchemes.map(s =>
    s.id === draft.activeIconSchemeId
      ? { ...s, iconSkins: { ...skins }, updatedAt: new Date().toISOString() }
      : s
  );

  return normalizeThemeProfile({ ...draft, iconSkins: skins, iconSchemes: schemes });
}

function IconSkinPage({
  draft,
  onDraftChange,
  onApply,
  onNotice,
}: {
  draft: ThemeProfile;
  onDraftChange: (next: ThemeProfile) => void;
  onApply: (next: ThemeProfile) => Promise<void> | void;
  onNotice: (text: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const dockFileRef = useRef<HTMLInputElement>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [dockThumbUrl, setDockThumbUrl] = useState<string | null>(null);
  const [uploadTarget, setUploadTarget] = useState<DesktopIconId | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<{ iconId: DesktopIconId; assetId: string } | null>(null);
  const [confirmDeleteDock, setConfirmDeleteDock] = useState(false);
  const [customApps, setCustomApps] = useState<InstalledCustomApp[]>(() => (
    typeof window === "undefined" ? [] : loadInstalledCustomApps()
  ));

  const activeSkins = resolveActiveIconSkins(draft);
  const allAssetIds = Object.values(activeSkins).filter(Boolean) as string[];
  const iconSkinItems = useMemo<IconSkinItem[]>(() => [
    ...BUILTIN_ICON_SKIN_IDS.map((id) => ({
      id,
      label: ICONS[id].label,
      builtinId: id,
    })),
    ...customApps.map((app) => ({
      id: toCustomAppIconId(app.id),
      label: app.name,
      builtinId: null,
      iconDataUrl: app.iconDataUrl,
    })),
  ], [customApps]);

  useEffect(() => {
    const refreshCustomApps = () => setCustomApps(loadInstalledCustomApps());
    refreshCustomApps();
    window.addEventListener(CUSTOM_APPS_UPDATED_EVENT, refreshCustomApps);
    return () => window.removeEventListener(CUSTOM_APPS_UPDATED_EVENT, refreshCustomApps);
  }, []);

  useEffect(() => {
    const idsToLoad = [...allAssetIds];
    if (draft.dockSkinAssetId) idsToLoad.push(draft.dockSkinAssetId);
    if (idsToLoad.length === 0) {
      setThumbs({});
      setDockThumbUrl(null);
      return;
    }
    let cancelled = false;
    getThemeAssetMap(idsToLoad).then((map) => {
      if (cancelled) return;
      setThumbs(map);
      setDockThumbUrl(draft.dockSkinAssetId ? map[draft.dockSkinAssetId] ?? null : null);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allAssetIds.join(","), draft.dockSkinAssetId]);

  const triggerUpload = useCallback((iconId: DesktopIconId) => {
    setUploadTarget(iconId);
    fileRef.current?.click();
  }, []);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !uploadTarget) return;
    e.target.value = "";

    try {
      const assetId = await saveThemeAssetFromBlob(file, "icon_skin");
      const next = updateIconSkin(draft, uploadTarget, assetId);
      onDraftChange(next);
      await onApply(next);
      const map = await getThemeAssetMap(
        (Object.values(resolveActiveIconSkins(next)).filter(Boolean) as string[])
      );
      setThumbs(map);
    } catch (error) {
      onNotice(describeAssetSaveError(error));
    }
    setUploadTarget(null);
  }, [draft, uploadTarget, onDraftChange, onApply, onNotice]);

  const handleDeleteClick = useCallback((iconId: DesktopIconId, assetId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteId({ iconId, assetId });
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!confirmDeleteId) return;
    const { iconId, assetId } = confirmDeleteId;
    setConfirmDeleteId(null);
    // 外观预设还引用着的素材只解除当前引用，不真删
    if (!isThemeAssetReferencedByPresets(assetId)) await deleteThemeAsset(assetId);
    const next = updateIconSkin(draft, iconId, null);
    onDraftChange(next);
    await onApply(next);
    onNotice("已还原默认图标");
  }, [confirmDeleteId, draft, onDraftChange, onApply, onNotice]);

  const triggerDockUpload = useCallback(() => {
    dockFileRef.current?.click();
  }, []);

  const handleDockUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    try {
      const assetId = await saveThemeAssetFromBlob(file, "dock_skin");
      const next = normalizeThemeProfile({ ...draft, dockSkinAssetId: assetId });
      onDraftChange(next);
      await onApply(next);
      const map = await getThemeAssetMap([assetId]);
      setDockThumbUrl(map[assetId] ?? null);
    } catch (error) {
      onNotice(describeAssetSaveError(error));
    }
  }, [draft, onDraftChange, onApply, onNotice]);

  const handleDockDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteDock(true);
  }, []);

  const handleDockDeleteConfirm = useCallback(async () => {
    setConfirmDeleteDock(false);
    if (draft.dockSkinAssetId && !isThemeAssetReferencedByPresets(draft.dockSkinAssetId)) {
      await deleteThemeAsset(draft.dockSkinAssetId);
    }
    const next = normalizeThemeProfile({ ...draft, dockSkinAssetId: null });
    onDraftChange(next);
    await onApply(next);
    setDockThumbUrl(null);
    onNotice("已还原 DOCK 栏背景");
  }, [draft, onDraftChange, onApply, onNotice]);

  const handleResetAll = useCallback(async () => {
    const ids = Object.values(activeSkins).filter(Boolean) as string[];
    if (draft.dockSkinAssetId) ids.push(draft.dockSkinAssetId);
    await Promise.all(ids.map(id => deleteThemeAsset(id)));
    const cleared: ThemeProfile = {
      ...draft,
      iconSkins: {},
      iconSchemes: draft.iconSchemes.map(s =>
        s.id === draft.activeIconSchemeId
          ? { ...s, iconSkins: {}, updatedAt: new Date().toISOString() }
          : s
      ),
      dockSkinAssetId: null,
    };
    const next = normalizeThemeProfile(cleared);
    onDraftChange(next);
    await onApply(next);
    setThumbs({});
    setDockThumbUrl(null);
    onNotice("已还原全部图标");
  }, [activeSkins, draft, onDraftChange, onApply, onNotice]);

  return (
    <div className="theme-section-page" data-bottom-reserve style={{ gap: 14 }}>
      <h3 className="appearance-menu-section-title">Icons</h3>
      <div className="is-grid">
        {iconSkinItems.map(item => {
          const skinAssetId = activeSkins[item.id];
          const skinUrl = skinAssetId ? thumbs[skinAssetId] : null;
          const previewUrl = skinUrl ?? item.iconDataUrl ?? null;
          return (
            <div key={item.id} className="is-cell" onClick={() => triggerUpload(item.id)}>
              <div className="is-frame" {...(previewUrl ? { "data-skinned": "" } : {})}>
                {previewUrl ? (
                  <img className="is-frame-img" src={previewUrl} alt="" />
                ) : item.builtinId ? (
                  <IconGlyph id={item.builtinId} className="is-frame-glyph" />
                ) : (
                  <IconGlyph id="appmarket" className="is-frame-glyph" />
                )}
                {skinAssetId && (
                  <button className="ui-card-delete" onClick={e => handleDeleteClick(item.id, skinAssetId, e)}>×</button>
                )}
              </div>
              <span className="is-label">{item.label}</span>
            </div>
          );
        })}
      </div>

      <p className="is-empty-hint">点击图标上传自定义图片</p>

      <h3 className="appearance-menu-section-title">Dock</h3>
      <div
        className="is-dock-preview"
        onClick={triggerDockUpload}
        {...(dockThumbUrl ? { "data-skinned": "" } : {})}
      >
        {dockThumbUrl ? (
          <>
            <img className="is-dock-preview-img" src={dockThumbUrl} alt="" />
            <button className="ui-card-delete" onClick={handleDockDeleteClick}>×</button>
          </>
        ) : (
          <span className="is-empty-hint">点击上传 DOCK 栏背景</span>
        )}
      </div>

      {(Object.keys(activeSkins).length > 0 || draft.dockSkinAssetId) && (
        <button
          type="button"
          className="inline-flex h-10 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] border border-black/10 bg-white px-4 text-xs font-bold text-gray-800 shadow-sm transition-all hover:bg-gray-50 hover:shadow-md active:scale-95 focus:outline-none"
          onClick={handleResetAll}
        >
          <RotateCcw size={15} strokeWidth={1.8} />
          <span>全部还原</span>
        </button>
      )}

      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />
      <input ref={dockFileRef} type="file" accept="image/*" className="hidden" onChange={handleDockUpload} />

      {confirmDeleteId && (
        <ConfirmDialog
          title="确定要还原这个图标吗？"
          message="将恢复为默认图标样式。"
          icon={AlertCircle}
          variant="danger"
          confirmLabel="还原"
          cancelLabel="取消"
          onConfirm={handleDeleteConfirm}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}

      {confirmDeleteDock && (
        <ConfirmDialog
          title="确定要还原 DOCK 栏背景吗？"
          message="将恢复为默认毛玻璃效果。"
          icon={AlertCircle}
          variant="danger"
          confirmLabel="还原"
          cancelLabel="取消"
          onConfirm={handleDockDeleteConfirm}
          onCancel={() => setConfirmDeleteDock(false)}
        />
      )}
    </div>
  );
}

/* ══════════════════════════════════════════
   Wallpaper Page
   ══════════════════════════════════════════ */

function WallpaperPage({
  draft,
  onDraftChange,
  onApply,
  onNotice,
}: {
  draft: ThemeProfile;
  onDraftChange: (next: ThemeProfile) => void;
  onApply: (next: ThemeProfile) => Promise<void> | void;
  onNotice: (text: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [sliderDraft, setSliderDraft] = useState<ThemeProfile>(draft);
  const sliderDraftRef = useRef<ThemeProfile>(draft);
  const sliderFrameRef = useRef<number | null>(null);

  const showToast = useCallback((text: string) => {
    clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(null), 1500);
  }, []);

  const library = draft.wallpaperLibrary;
  const hasWallpaper = !!draft.wallpaperAssetId;

  useEffect(() => {
    sliderDraftRef.current = draft;
    setSliderDraft(draft);
  }, [
    draft.wallpaperAssetId,
    draft.wallpaperOpacity,
    draft.wallpaperBlur,
    draft.wallpaperScale,
    draft.wallpaperX,
    draft.wallpaperY,
  ]);

  useEffect(() => {
    return () => {
      if (sliderFrameRef.current !== null) cancelAnimationFrame(sliderFrameRef.current);
    };
  }, []);

  const scheduleSliderPreview = useCallback(() => {
    if (sliderFrameRef.current !== null) return;
    sliderFrameRef.current = requestAnimationFrame(() => {
      sliderFrameRef.current = null;
      onDraftChange(sliderDraftRef.current);
    });
  }, [onDraftChange]);

  // Load thumbnails when library contents change (join for stable dep)
  useEffect(() => {
    if (library.length === 0) {
      setThumbs({});
      return;
    }
    let cancelled = false;
    getThemeAssetMap(library).then((map) => {
      if (!cancelled) setThumbs(map);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library.join(",")]);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input so same file can be re-selected
    e.target.value = "";

    try {
      const assetId = await saveThemeAssetFromBlob(file, "wallpaper");
      const updatedLibrary = [...draft.wallpaperLibrary, assetId];
      const next = normalizeThemeProfile({
        ...draft,
        wallpaperAssetId: assetId,
        wallpaperLibrary: updatedLibrary,
      });
      onDraftChange(next);
      await onApply(next);
      // Reload thumbnails for the new asset
      const map = await getThemeAssetMap(next.wallpaperLibrary);
      setThumbs(map);
    } catch (error) {
      onNotice(describeAssetSaveError(error));
    }
  }, [draft, onDraftChange, onApply, onNotice]);

  const handleSelect = useCallback(async (assetId: string) => {
    if (draft.wallpaperAssetId === assetId) {
      const next = normalizeThemeProfile({ ...draft, wallpaperAssetId: null });
      onDraftChange(next);
      await onApply(next);
      showToast("\u5DF2\u53D6\u6D88\u5E94\u7528\u58C1\u7EB8");
      return;
    }
    const next = normalizeThemeProfile({
      ...draft,
      wallpaperAssetId: assetId,
    });
    onDraftChange(next);
    await onApply(next);
    showToast("\u5DF2\u5207\u6362\u58C1\u7EB8");
  }, [draft, onDraftChange, onApply, showToast]);

  const handleDeleteClick = useCallback((assetId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteId(assetId);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!confirmDeleteId) return;
    await deleteThemeAsset(confirmDeleteId);
    const updatedLibrary = draft.wallpaperLibrary.filter((id) => id !== confirmDeleteId);
    const next = normalizeThemeProfile({
      ...draft,
      wallpaperAssetId: draft.wallpaperAssetId === confirmDeleteId ? null : draft.wallpaperAssetId,
      wallpaperLibrary: updatedLibrary,
    });
    setConfirmDeleteId(null);
    onDraftChange(next);
    await onApply(next);
  }, [confirmDeleteId, draft, onDraftChange, onApply]);

  const handleDeleteCancel = useCallback(() => {
    setConfirmDeleteId(null);
  }, []);

  const handleSliderChange = useCallback((field: WallpaperSliderField, value: number) => {
    const next = normalizeThemeProfile({ ...sliderDraftRef.current, [field]: value });
    sliderDraftRef.current = next;
    setSliderDraft(next);
    scheduleSliderPreview();
  }, [scheduleSliderPreview]);

  const handleSliderCommit = useCallback(() => {
    if (sliderFrameRef.current !== null) {
      cancelAnimationFrame(sliderFrameRef.current);
      sliderFrameRef.current = null;
    }
    const next = sliderDraftRef.current;
    onDraftChange(next);
    onApply(next);
  }, [onApply, onDraftChange]);

  return (
    <div className="theme-section-page" data-bottom-reserve style={{ gap: 14 }}>
      {/* Upload button */}
      <div className="flex flex-col items-center justify-center pt-2 pb-4 border-b border-black/5">
        <button
          type="button"
          className="inline-flex items-center justify-center gap-1.5 rounded-[20px] bg-black px-6 py-2.5 text-sm font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
          onClick={() => fileRef.current?.click()}
        >
          <Plus size={15} strokeWidth={1.8} />
          {"\u6DFB\u52A0\u58C1\u7EB8"}
        </button>
        <p className="mt-3 text-[calc(11px*var(--app-text-scale,1))] font-medium text-gray-400">上传并管理个性化桌面壁纸</p>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleUpload}
      />

      {/* Sliders — only when a wallpaper is active */}
      {hasWallpaper && (
        <div className="g-card wp-sliders">
          <div className="wp-slider-row">
            <label>{"\u900F\u660E\u5EA6"}</label>
            <input
              className="ui-slider"
              type="range"
              min={0}
              max={100}
              step="any"
              value={sliderDraft.wallpaperOpacity * 100}
              onChange={(e) => handleSliderChange("wallpaperOpacity", Number(e.target.value) / 100)}
              onMouseUp={handleSliderCommit}
              onTouchEnd={handleSliderCommit}
            />
            <span className="wp-slider-value">{Math.round(sliderDraft.wallpaperOpacity * 100)}</span>
          </div>
          <div className="wp-slider-row">
            <label>{"\u6A21\u7CCA\u5EA6"}</label>
            <input
              className="ui-slider"
              type="range"
              min={0}
              max={24}
              step="any"
              value={sliderDraft.wallpaperBlur}
              onChange={(e) => handleSliderChange("wallpaperBlur", Number(e.target.value))}
              onMouseUp={handleSliderCommit}
              onTouchEnd={handleSliderCommit}
            />
            <span className="wp-slider-value">{Math.round(sliderDraft.wallpaperBlur)}</span>
          </div>
          <div className="wp-slider-row">
            <label>{"\u7F29\u653E\u5EA6"}</label>
            <input
              className="ui-slider"
              type="range"
              min={10}
              max={200}
              step="any"
              value={sliderDraft.wallpaperScale}
              onChange={(e) => handleSliderChange("wallpaperScale", Number(e.target.value))}
              onMouseUp={handleSliderCommit}
              onTouchEnd={handleSliderCommit}
            />
            <span className="wp-slider-value">{Math.round(sliderDraft.wallpaperScale)}%</span>
          </div>
          <div className="wp-slider-row">
            <label>{"X \u504F\u79FB"}</label>
            <input
              className="ui-slider"
              type="range"
              min={0}
              max={100}
              step="any"
              value={sliderDraft.wallpaperX}
              onChange={(e) => handleSliderChange("wallpaperX", Number(e.target.value))}
              onMouseUp={handleSliderCommit}
              onTouchEnd={handleSliderCommit}
            />
            <span className="wp-slider-value">{Math.round(sliderDraft.wallpaperX)}%</span>
          </div>
          <div className="wp-slider-row">
            <label>{"Y \u504F\u79FB"}</label>
            <input
              className="ui-slider"
              type="range"
              min={0}
              max={100}
              step="any"
              value={sliderDraft.wallpaperY}
              onChange={(e) => handleSliderChange("wallpaperY", Number(e.target.value))}
              onMouseUp={handleSliderCommit}
              onTouchEnd={handleSliderCommit}
            />
            <span className="wp-slider-value">{Math.round(sliderDraft.wallpaperY)}%</span>
          </div>
        </div>
      )}

      {/* Wallpaper library grid */}
      {library.length > 0 ? (
        <div className="wp-grid">
          {library.map((assetId) => {
            const isActive = draft.wallpaperAssetId === assetId;
            const src = thumbs[assetId];
            return (
              <div
                key={assetId}
                className={`wp-card${isActive ? " wp-card-active" : ""}`}
                onClick={() => handleSelect(assetId)}
                role="button"
                tabIndex={0}
              >
                {src ? (
                  <img className="wp-card-img" src={src} alt="" />
                ) : (
                  <div className="wp-card-img bg-[var(--c-page-body-bg)]" />
                )}
                {isActive && <span className="wp-card-badge">{"\u4F7F\u7528\u4E2D"}</span>}
                <button
                  type="button"
                  className="ui-card-delete"
                  onClick={(e) => handleDeleteClick(assetId, e)}
                  aria-label={"\u5220\u9664"}
                >
                  {"\u00D7"}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="wp-empty">{"\u8FD8\u6CA1\u6709\u58C1\u7EB8\uFF0C\u70B9\u51FB\u4E0A\u65B9\u6DFB\u52A0"}</p>
      )}

      {/* Bottom toast */}
      {toast && <div className="wp-toast">{toast}</div>}

      {/* Delete confirmation dialog */}
      {confirmDeleteId && (
        <ConfirmDialog
          title="确定要删除这张壁纸吗？"
          message="删除壁纸后无法恢复。是否继续？"
          icon={AlertCircle}
          variant="danger"
          confirmLabel="删除"
          cancelLabel="取消"
          onConfirm={handleDeleteConfirm}
          onCancel={handleDeleteCancel}
        />
      )}
    </div>
  );
}

/* ══════════════════════════════════════════
   Widget Manager Page
   ══════════════════════════════════════════ */

function WidgetManagerPage({
  widgets,
  onWidgetsChange,
  pageIcons,
  iconSkins,
  wallpaperStyle,
}: {
  widgets: WidgetInstance[];
  onWidgetsChange: (next: WidgetInstance[]) => void;
  pageIcons: DesktopIconLayout;
  iconSkins: Record<string, string | null>;
  wallpaperStyle?: CSSProperties;
}) {
  const [diyTemplates, setDiyTemplates] = useState<DIYWidgetTemplate[]>([]);
  const [showStudio, setShowStudio] = useState<boolean>(false);
  const [editingTemplate, setEditingTemplate] = useState<DIYWidgetTemplate | undefined>(undefined);

  useEffect(() => {
    setDiyTemplates(loadDIYTemplates());
  }, []);

  const mergedCatalog = useMemo(() => {
    const diyEntries = diyTemplates.map(t => ({
      type: t.id as WidgetType,
      name: t.name || "DIY组件",
      desc: t.mode === "image" ? "图片贴纸" : "自定义代码",
      size: t.size,
      track: "freestyle" as const
    }));
    return [...WIDGET_CATALOG, ...diyEntries];
  }, [diyTemplates]);

  return (
    <div className="theme-section-page flex flex-col gap-6" data-bottom-reserve style={{ padding: "16px 20px 0" }}>
      
      {/* Studio Header Toggle */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col items-center justify-center pt-2 pb-4 border-b border-black/5">
          <button
             className={`px-6 py-2.5 rounded-[20px] text-sm font-bold shadow-sm transition-all focus:outline-none ${(showStudio && !editingTemplate) ? 'bg-gray-200 text-gray-700 hover:bg-gray-300' : 'bg-black text-white hover:bg-gray-800 hover:shadow-md active:scale-95'}`}
             onClick={() => {
               if (showStudio && !editingTemplate) {
                 setShowStudio(false);
               } else {
                 setEditingTemplate(undefined);
                 setShowStudio(true);
               }
             }}
          >
            {(showStudio && !editingTemplate) ? "收起面板" : "➕ 创建新组件"}
          </button>
          <p className="text-[calc(11px*var(--app-text-scale,1))] text-gray-400 font-medium mt-3">创建和管理个性化桌面组件</p>
        </div>
        
        {/* 新建面板（顶部）。编辑已有组件改为在该组件下方就地展开。 */}
        {showStudio && !editingTemplate && (
          <div className="rounded-[32px] w-full">
             <DIYWidgetEditor
               template={undefined}
               onClose={() => setShowStudio(false)}
               onSave={(newTemplate) => {
                 const updated = [...diyTemplates, newTemplate];
                 saveDIYTemplates(updated);
                 setDiyTemplates(updated);
                 setShowStudio(false);
               }}
             />
          </div>
        )}
      </div>

      {/* Widget catalog */}
      <div className="wm-catalog" style={{ marginTop: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 className="wm-catalog-title" style={{ margin: 0 }}>{"\u7EC4\u4EF6\u4ED3\u5E93"}</h3>
          <span className="text-[calc(11px*var(--app-text-scale,1))] text-gray-400 font-medium">长按手机桌面的空白处即可将组件添加到主屏幕</span>
        </div>
        <div className="wm-catalog-list">
          {mergedCatalog.map((entry) => {
            const sizeClass = `wm-cat-size-${entry.size}`;
            const dummyWidget: WidgetInstance = {
              id: `cat-${entry.type}`,
              type: entry.type,
              size: entry.size,
              page: 1,
              row: 1,
              col: 1,
            };
            const isDIY = entry.type.startsWith("diy-");
            const isEditingThis = isDIY && showStudio && editingTemplate?.id === entry.type;
            return (
              <Fragment key={entry.type}>
              <div
                className={`wm-cat-item ${sizeClass} relative group ${isEditingThis ? "wm-cat-active" : ""}`}
                style={{ overflow: "visible" }}
              >
                {isDIY && (
                  <button
                    className="absolute top-0 right-0 translate-x-1/4 -translate-y-1/4 z-20 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center shadow-md border-2 border-white transition-transform active:scale-95"
                    title="删除自制组件"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm("确定要删除这个自制组件吗？桌面上已添加的相关组件可能也会丢失界面。")) {
                         const updated = diyTemplates.filter(t => t.id !== entry.type);
                         saveDIYTemplates(updated);
                         setDiyTemplates(updated);
                         if (editingTemplate?.id === entry.type) { setShowStudio(false); setEditingTemplate(undefined); }
                      }
                    }}
                  >
                   <span className="mb-[2px] leading-none text-sm font-bold">×</span>
                  </button>
                )}
                <div role="button" tabIndex={0} onClick={() => {
                    if(isDIY) {
                      if (isEditingThis) {
                        setShowStudio(false);
                        setEditingTemplate(undefined);
                      } else {
                        const template = diyTemplates.find(t => t.id === entry.type);
                        setEditingTemplate(template);
                        setShowStudio(true);
                      }
                    }
                  }} className="w-full h-full flex flex-col items-center gap-2">
                  <WidgetRenderer widget={dummyWidget} preview />
                  <span className="wm-cat-name">{entry.name}</span>
                </div>
              </div>
              {isEditingThis && (
                <div style={{ flexBasis: "100%", width: "100%" }} className="rounded-[32px]">
                  <DIYWidgetEditor
                    template={editingTemplate}
                    onClose={() => { setShowStudio(false); setEditingTemplate(undefined); }}
                    onSave={(newTemplate) => {
                      const updated = diyTemplates.map(t => t.id === newTemplate.id ? newTemplate : t);
                      saveDIYTemplates(updated);
                      setDiyTemplates(updated);
                      setShowStudio(false);
                      setEditingTemplate(undefined);
                    }}
                  />
                </div>
              )}
              </Fragment>
            );
          })}
        </div>
      </div>
      
    </div>
  );
}
