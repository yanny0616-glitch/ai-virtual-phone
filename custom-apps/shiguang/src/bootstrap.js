  /* ================= 启动 ================= */
  async function start() {
    S.api = window.AiPhone;
    if (!S.api || !S.api.db || !S.api.chat || !S.api.chat.setContext) {
      notice("这个版本的小手机还不支持拾光 APP，请先更新宿主。", true); $("cards").innerHTML = ""; return;
    }
    S.api.on("chat.message.created", onChatMessage);
    if (S.api.chat.registerContextProvider) {
      S.api.chat.registerContextProvider(providePromptContext).catch(err => console.warn("[拾光] 当轮回忆注册失败", err));
    }
    S.launch = await S.api.app.getLaunchContext().catch(() => null);
    S.background = !!(S.launch && S.launch.background);
    if (S.background) return;   // 隐藏环境只跑事件 handler，不渲染界面
    busy(true);
    try {
      const [characters] = await Promise.all([S.api.characters.list(), loadSettings()]);
      S.characters = Array.isArray(characters) ? characters : (characters && characters.characters) || [];
      renderSettings();
      $("character").innerHTML = S.characters.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("") || '<option value="">还没有角色</option>';
      const launchId = S.launch && S.launch.characterId;
      S.characterId = S.characters.some(c => c.id === launchId) ? launchId : (S.characters[0] && S.characters[0].id) || "";
      $("character").value = S.characterId;
      await load();
    } catch (err) { notice(errText(err), true); $("cards").innerHTML = '<p class="sg-empty">记忆未能读取，点击刷新重试。</p>'; }
    finally { busy(false); }
  }
  bindList(); bindEditor(); bindSettings();
  void start();
