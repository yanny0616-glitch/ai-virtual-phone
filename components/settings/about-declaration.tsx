"use client";

import { Info, ShieldAlert, Github } from "lucide-react";
import { typeset } from "@/lib/cjk-typeset";
import { SelfHostUpdateCard } from "./self-host-update";
import { ChangelogHistoryRow } from "../changelog-sheet";

const AI_CONTENT_TEXT = typeset("本应用内的所有角色对话、动态内容均为人工智能模型自动生成。生成内容不代表本平台的立场与观点，亦不对应任何现实中的人物、事件。用户应当自行辨别并承担使用风险。");
const PRIVACY_TEXT = typeset("您的日记、聊天记录及身份预设等敏感数据默认保存在本地浏览器中（LocalStorage/IndexedDB）。清理浏览器缓存可能会导致数据丢失，请注意妥善备份。若您在云服务设置中主动开启「聊天镜像」，新的单聊消息会抄送一份到您自己的 Supabase 项目（仅您本人可访问，保留 60 天，可随时清空），用于离线主动消息的云端判断。");
const DEPLOY_TEXT = typeset("本项目仅供个人及亲友使用，GitHub 仓库为 xiaolongbao0709/ai-virtual-phone。如果你并非从该 GitHub 仓库自行部署，而是从其他小手机或网站进入，那么你被骗了，请自己前往仓库部署，不要使用别人未获授权的网站。");
const REPO_URL = typeset("https://github.com/xiaolongbao0709/ai-virtual-phone");

export function AboutDeclaration({ onNotice }: { onNotice?: (msg: string) => void }) {
    return (
        <div className="flex flex-col gap-5 h-full">
            <SelfHostUpdateCard onNotice={onNotice ?? (() => { })} />
            <ChangelogHistoryRow />

            <p className="card-section-label m-0 mx-2">免责声明</p>

            <div className="g-card">
                <div className="flex items-start gap-3">
                    <ShieldAlert size={20} className="shrink-0 mt-0.5 text-[var(--c-warning)]" />
                    <div className="flex flex-col gap-2">
                        <span className="menu-label font-semibold">AI 生成内容声明</span>
                        <span className="menu-desc ts-13 leading-relaxed !mt-0">{AI_CONTENT_TEXT}</span>
                    </div>
                </div>
                <div className="ui-row-divider !mx-0" />
                <div className="flex items-start gap-3">
                    <Info size={20} className="shrink-0 mt-0.5 text-[var(--c-icon-active)]" />
                    <div className="flex flex-col gap-2">
                        <span className="menu-label font-semibold">隐私与数据安全</span>
                        <span className="menu-desc ts-13 leading-relaxed !mt-0">{PRIVACY_TEXT}</span>
                    </div>
                </div>
            </div>

            <p className="card-section-label m-0 mx-2">相关信息</p>

            <div className="g-card">
                <div className="flex items-start gap-3">
                    <Github size={20} className="shrink-0 mt-0.5 text-[var(--c-icon-rose)]" />
                    <div className="flex flex-col gap-2 min-w-0">
                        <span className="menu-label font-semibold">使用与部署声明</span>
                        <span className="menu-desc ts-13 leading-relaxed !mt-0">{DEPLOY_TEXT}</span>
                        <a
                            href={REPO_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="menu-desc ts-13 !mt-0 break-all underline text-[var(--c-icon-active)]"
                        >
                            {REPO_URL}
                        </a>
                    </div>
                </div>
            </div>

        </div>
    );
}
