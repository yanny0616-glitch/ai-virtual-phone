import { getMusicControlBridge } from './music-control-bridge';
export type WidgetMusicState = { available: boolean; track: { id: string; title: string; artist: string; coverUrl: string } | null; isPlaying: boolean; currentTime: number; duration: number };
const SOURCE = 'ai-phone-widget-music';
const diagnostics = new Map<string, Array<{ at: string; message: string }>>();
export function readWidgetDiagnostics(id?: string) {
  return { instances: [...diagnostics].filter(([key]) => !id || id === key).map(([widgetId, errors]) => ({ widgetId, errors })), note: '只包含当前页面已挂载 iframe 报告的错误；没有报错不代表已完成视觉或交互验证。' };
}
export function widgetMusicState(): WidgetMusicState {
  const state = getMusicControlBridge()?.getState();
  const track = state?.currentTrack;
  return { available: !!state, track: track ? { id: track.id, title: track.title, artist: track.artist, coverUrl: track.coverUrl || '' } : null, isPlaying: state?.isPlaying ?? false, currentTime: state?.currentTime ?? 0, duration: state?.duration ?? 0 };
}
export function attachWidgetMusicBridge(target: Window, widgetId: string, readOnly: boolean): () => void {
  let subscribed = false, last = '';
  diagnostics.set(widgetId, []);
  const send = (data: Record<string, unknown>) => target.postMessage({ source: SOURCE + '-host', widgetId, ...data }, '*');
  const handler = (event: MessageEvent) => {
    const data = event.data;
    if (event.source !== target || !data || data.source !== SOURCE || data.widgetId !== widgetId) return;
    if (data.action === 'error') {
      const errors = diagnostics.get(widgetId) ?? []; errors.push({ at: new Date().toISOString(), message: String(data.message || '未知脚本错误').slice(0, 1200) }); diagnostics.set(widgetId, errors.slice(-10)); return;
    }
    if (data.action === 'subscribe') { subscribed = true; last = ''; return; }
    if (data.action === 'unsubscribe') { subscribed = false; return; }
    if (typeof data.requestId !== 'string' || data.requestId.length > 100) return;
    try {
      if (data.action !== 'getState') {
        if (readOnly) throw Error('这是只读预览，请应用到桌面后控制播放');
        const bridge = getMusicControlBridge(); if (!bridge) throw Error('音乐播放器尚未准备好');
        if (data.action !== 'openPlayer' && !bridge.getState().currentTrack) throw Error('请先在音乐 App 选择一首歌曲');
        switch (data.action) {
          case 'play': bridge.resume(); break;
          case 'pause': bridge.pause(); break;
          case 'togglePlay': if (bridge.getState().isPlaying) bridge.pause(); else bridge.resume(); break;
          case 'next': bridge.next(); break;
          case 'prev': bridge.prev(); break;
          case 'seek': {
            if (typeof data.value !== 'number' || !Number.isFinite(data.value)) throw Error('播放位置需要有限秒数');
            if (!bridge.seek) throw Error('播放器暂不支持调整进度');
            bridge.seek(Math.max(0, Math.min(bridge.getState().duration, data.value))); break;
          }
          case 'openPlayer': if (!bridge.openPlayer) throw Error('播放器暂不可打开'); bridge.openPlayer(); break;
          default: throw Error('不支持的音乐动作');
        }
      }
      send({ requestId: data.requestId, state: widgetMusicState() });
    } catch (e) { send({ requestId: data.requestId, error: e instanceof Error ? e.message : '音乐操作失败' }); }
  };
  window.addEventListener('message', handler);
  const timer = window.setInterval(() => {
    if (!subscribed) return; const state = widgetMusicState(); const serialized = JSON.stringify(state);
    if (serialized !== last) { last = serialized; send({ type: 'state', state }); }
  }, 500);
  return () => { window.removeEventListener('message', handler); window.clearInterval(timer); diagnostics.delete(widgetId); };
}
/** Injected into both real widgets and preview widgets before user HTML executes. */
export function widgetMusicClientScript(widgetId: string): string {
  return `<script>(function(){
var SOURCE=${JSON.stringify(SOURCE)},widgetId=${JSON.stringify(widgetId).replace(/</g, '\\u003c')},pending={},listeners=[],seq=0;
function send(data){parent.postMessage(Object.assign({source:SOURCE,widgetId:widgetId},data),'*');}
function request(action,value){return new Promise(function(resolve,reject){var id=String(++seq);var timer=setTimeout(function(){delete pending[id];reject(new Error('音乐接口响应超时'));},10000);pending[id]={resolve:resolve,reject:reject,timer:timer};send({requestId:id,action:action,value:value});});}
window.addEventListener('message',function(event){var data=event.data;if(event.source!==parent||!data||data.source!==SOURCE+'-host'||data.widgetId!==widgetId)return;if(data.type==='state'){listeners.slice().forEach(function(fn){try{fn(data.state);}catch(e){send({action:'error',message:String(e)});}});return;}var p=pending[data.requestId];if(!p)return;clearTimeout(p.timer);delete pending[data.requestId];if(data.error)p.reject(new Error(data.error));else p.resolve(data.state);});
var api=window.AiPhoneWidget||{};var music={getState:function(){return request('getState');},subscribe:function(fn){if(typeof fn!=='function')throw new Error('subscribe 需要函数');listeners.push(fn);send({action:'subscribe'});return function(){listeners=listeners.filter(function(f){return f!==fn;});if(!listeners.length)send({action:'unsubscribe'});};}};
['play','pause','togglePlay','next','prev','seek','openPlayer'].forEach(function(action){music[action]=function(value){return request(action,value);};});api.music=music;window.AiPhoneWidget=api;
window.addEventListener('error',function(e){send({action:'error',message:e.message||'脚本或资源加载错误'});});
window.addEventListener('unhandledrejection',function(e){send({action:'error',message:String(e.reason&&e.reason.message||e.reason)});});
})();<\/script>`;
}
