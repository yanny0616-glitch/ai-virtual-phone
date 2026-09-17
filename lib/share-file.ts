/** iPhone 上弹系统分享面板（能存到相册 / 文件）；不支持分享文件的环境直接下载。
 *  必须在点击回调里同步走到这里：先生成好 blob，再让用户点第二下。 */
export async function shareOrDownloadFile(blob: Blob, filename: string, title?: string): Promise<"shared" | "downloaded" | "cancelled"> {
    const file = new File([blob], filename, { type: blob.type });
    if (typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] })) {
        try {
            await navigator.share({ files: [file], title });
            return "shared";
        } catch (error) {
            if ((error as Error)?.name === "AbortError") return "cancelled";
        }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return "downloaded";
}
