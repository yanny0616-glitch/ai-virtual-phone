import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url), cache = new Map();
const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const note = { url:'https://www.xiaohongshu.com/explore/0123456789abcdef01234567',title:'真实笔记',author:'作者',desc:'正文',images:[0,1,2].map(i=>({url:'https://ci.xiaohongshu.com/'+i})),imageCount:3,likedCount:'10',commentCount:'20',collectedCount:'5',comments:[{user:'读者',content:'公开评论',ipLocation:'上海'}],warnings:[],noteType:'normal' };
let stored = 0, loggedIn = false;
const realFetch = globalThis.fetch;
const oldEnv = [process.env.XHS_MCP_ACCESS_TOKEN, process.env.XHS_BROWSER_TOKEN];
process.env.XHS_MCP_ACCESS_TOKEN='test_mcp_access'; process.env.XHS_BROWSER_TOKEN='test_backend';
globalThis.fetch = async (url, options) => {
    assert.ok(url.startsWith('http://127.0.0.1:18061/'));
    assert.equal(options.headers.Authorization,'Bearer test_backend');
    if(url.endsWith('/cookie'))return Response.json({ok:true,data:{state:'ready',configured:true,message:'已登录'}});
    if(url.endsWith('/status'))return Response.json({ok:true,data:{state:loggedIn?'ready':'unconfigured',message:loggedIn?'已登录':'搜索未登录'}});
    const body=JSON.parse(options.body);
    if(!loggedIn)return Response.json({error:'公开链接可读，搜索未登录'},{status:400});
    if(body.command==='search' || body.command==='list-feeds' || body.command==='user-profile') return Response.json({ok:true,data:{feeds:Array.from({length:10},(_,i)=>({id:i.toString(16).padStart(24,'0'),xsecToken:'token_'+i+'_'.repeat(100),title:'标题'+i,user:{nickname:'作者'}}))}});
    return Response.json({ok:true,data:{success:true,command:body.command}});
};

function load(file) {
    const absolute=path.resolve(root,file);
    if(cache.has(absolute))return cache.get(absolute).exports;
    const module={exports:{}};cache.set(absolute,module);
    const src=fs.readFileSync(absolute,'utf8');
    const code=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const resolve=name=>{
        if(name==='./xhs-reader')return {readXhsNote:async()=>structuredClone(note),readXhsImage:async url=>{if(url.endsWith('/1'))throw Error('不可见');return {base64:b64,mime:'image/png'};}};
        if(name==='./media-cache-storage')return {storeMediaBase64:async()=>({ref:'media-store://'+ ++stored}),deleteMediaRef:async()=>{}};
        if(name.startsWith('@/'))return load(name.slice(2)+'.ts');
        if(name.startsWith('.'))return load(path.resolve(path.dirname(absolute),name+'.ts'));
        return require(name);
    };
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`,{filename:absolute})(resolve,module,module.exports);
    return module.exports;
}
try {
    const server=load('lib/server/xhs-mcp.ts'), route=load('app/api/xhs-mcp/route.ts'), client=load('lib/xhs-mcp-result.ts'), xhs=load('lib/xhs-note.ts');
    const request=async(method,params={},auth=true)=>route.POST(new Request('https://float.yanny.top/api/xhs-mcp',{method:'POST',headers:{Authorization:auth?'Bearer test_mcp_access':'Bearer wrong','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}));
    assert.equal((await request('tools/list',{},false)).status,401);
    const {NextRequest}=require('next/server');
    const gate=load('lib/account-gate-cookie.ts'), cookieNames=load('lib/account-cookie-constants.ts');
    const savedSecret=process.env.ACCOUNT_GATE_SECRET, savedMode=process.env.NEXT_PUBLIC_SELF_HOSTED_MODE;
    process.env.ACCOUNT_GATE_SECRET='test-only-gate-secret';process.env.NEXT_PUBLIC_SELF_HOSTED_MODE='false';
    try {
      const session='test-session', value=await gate.createAccountGateCookieValue(session,300);
      const browserRequest=(origin,cookie)=>new NextRequest('https://float.yanny.top/api/xhs-mcp',{method:'POST',headers:{origin,'sec-fetch-site':'same-origin','content-type':'application/json',cookie},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_xiaohongshu_note',arguments:{url:note.url}}})});
      const cookie=`${cookieNames.ACCOUNT_SESSION_COOKIE}=${session}; ${cookieNames.ACCOUNT_GATE_COOKIE}=${value}`;
      assert.equal((await route.POST(browserRequest('https://evil.test',cookie))).status,401);
      assert.equal((await route.POST(browserRequest('https://float.yanny.top',''))).status,401);
      const browserResponse=await (await route.POST(browserRequest('https://float.yanny.top',cookie))).json();
      assert.equal(browserResponse.result.structuredContent.floatXhsNote.action,'read');
      const proxied=browserRequest('https://float.yanny.top',cookie);
      proxied.headers.set('host','float.yanny.top');
      const internal=new NextRequest('http://localhost:3001/api/xhs-mcp',{method:'POST',headers:proxied.headers,body:await proxied.text()});
      assert.equal((await (await route.POST(internal)).json()).result.structuredContent.floatXhsNote.action,'read');
      const accountRoute=load('app/api/xhs-account/route.ts');
      const adminReq=(withCookie,origin='https://float.yanny.top')=>new NextRequest('https://float.yanny.top/api/xhs-account',{method:'POST',headers:{origin,'sec-fetch-site':'same-origin','content-type':'application/json',cookie:withCookie?cookie:'',Authorization:'Bearer test_mcp_access'},body:JSON.stringify({action:'save',cookie:'a1=test; web_session=never-echo-this'})});
      assert.equal((await accountRoute.POST(adminReq(false))).status,401);
      assert.equal((await accountRoute.POST(adminReq(true,'https://evil.test'))).status,401);
      const saved=await (await accountRoute.POST(adminReq(true))).json();assert.equal(saved.state,'ready');assert.ok(!JSON.stringify(saved).includes('never-echo-this'));


    } finally {
      if(savedSecret===undefined)delete process.env.ACCOUNT_GATE_SECRET;else process.env.ACCOUNT_GATE_SECRET=savedSecret;
      if(savedMode===undefined)delete process.env.NEXT_PUBLIC_SELF_HOSTED_MODE;else process.env.NEXT_PUBLIC_SELF_HOSTED_MODE=savedMode;
    }
    const init=await (await request('initialize',{protocolVersion:'2025-03-26'})).json();assert.equal(init.result.protocolVersion,'2025-03-26');
    const tools=await (await request('tools/list')).json();assert.equal(tools.result.tools.length,12);
    assert.ok(tools.result.tools.some(t=>t.name==='publish_xiaohongshu_note'));
    const failed=await (await request('tools/call',{name:'search_xiaohongshu_notes',arguments:{keyword:'猫'}})).json();
    assert.ok(failed.result.isError);assert.match(failed.result.content[0].text,/登录/);
    loggedIn=true;
    for(const [name,args] of [
      ['get_xiaohongshu_recommendations',{}], ['get_xiaohongshu_profile',{user_id:'0123456789abcdef01234567'}],
      ['like_xiaohongshu_note',{feed_id:'0123456789abcdef01234567'}], ['favorite_xiaohongshu_note',{feed_id:'0123456789abcdef01234567',unfavorite:true}],
      ['post_xiaohongshu_comment',{feed_id:'0123456789abcdef01234567',content:'test',xsec_token:'test'}],
      ['reply_xiaohongshu_comment',{feed_id:'0123456789abcdef01234567',comment_id:'0123456789abcdef01234567',content:'test',xsec_token:'test'}],
      ['publish_xiaohongshu_note',{title:'test',content:'test',images:['https://example.com/photo.png']}],
    ]) { const result=await server.callXhsMcpTool(name,args);assert.ok(result.content.length); }
    await assert.rejects(server.callXhsMcpTool('publish_xiaohongshu_note',{title:'a',content:'b',images:['http://127.0.0.1/a']}));
    await assert.rejects(server.callXhsMcpTool('post_xiaohongshu_comment',{feed_id:'invalid',content:'test'}));

    const search=await server.callXhsMcpTool('search_xiaohongshu_notes',{keyword:'猫',limit:10});
    const searchPresentation=await client.extractXhsMcpPresentation(search);
    assert.equal(JSON.parse(searchPresentation.data).notes.length,10);assert.ok(searchPresentation.data.length>2000);
    const read=await server.callXhsMcpTool('read_xiaohongshu_note',{url:note.url});
    assert.deepEqual(read.structuredContent.floatXhsNote.imageIndexes,[0,2]);
    const readPresentation=await client.extractXhsMcpPresentation(read);
    assert.equal(stored,0);assert.equal(readPresentation.cards.length,0);assert.equal(readPresentation.images.length,2);
    assert.match(readPresentation.images[1].contextText,/第 3 张/);assert.match(readPresentation.data,/本次未读取评论/);
    const share=await server.callXhsMcpTool('share_xiaohongshu_note',{url:note.url});
    const shared=await client.extractXhsMcpPresentation(share);
    assert.equal(stored,2);assert.equal(shared.cards.length,1);assert.equal(shared.cards[0].status,'partial');
    assert.equal(shared.cards[0].note.images[1].error,'不可见');assert.match(shared.data,/卡片已发送/);
    note.images[2].commentIndex=0;
    const bodyOnly=await server.callXhsMcpTool('read_xiaohongshu_note',{url:note.url});
    assert.equal(bodyOnly.structuredContent.floatXhsNote.note.comments.length,0);
    assert.equal(bodyOnly.structuredContent.floatXhsNote.note.images.length,2);
    assert.equal(bodyOnly.structuredContent.floatXhsNote.note.commentsRead,false);
    const commentRead=await server.callXhsMcpTool('read_xiaohongshu_comments',{url:note.url,limit:1});
    assert.equal(commentRead.structuredContent.floatXhsNote.note.comments.length,1);
    assert.equal(commentRead.structuredContent.floatXhsNote.note.images.length,1);
    const automatic=await client.extractXhsMcpPresentation(commentRead,undefined,true);
    assert.equal(automatic.cards.length,0);assert.equal(automatic.snapshot.note.images[0].commentIndex,0);
    assert.match(automatic.images[0].contextText,/属于评论 1/);
    const emptyPage=await server.callXhsMcpTool('read_xiaohongshu_comments',{url:note.url,offset:1,limit:1});
    assert.equal(emptyPage.structuredContent.floatXhsNote.note.images.length,0);
    await assert.rejects(server.callXhsMcpTool('read_xiaohongshu_comments',{url:note.url,limit:99}));
    delete note.images[2].commentIndex;
    const invalid=structuredClone(share);invalid.structuredContent.floatXhsNote.note.title={html:'bad'};
    await assert.rejects(client.extractXhsMcpPresentation(invalid),/无效/);
    assert.equal(JSON.stringify((await (await request('tools/list')).json()).result.tools),JSON.stringify(tools.result.tools));
    const js=source=>stripTypeScriptTypes(source).replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'');
    const context=vm.createContext({console,compactToolHistory:value=>value,formatXhsNoteSnapshot:xhs.formatXhsNoteSnapshot,resolvePromptTimeAware:v=>v,buildCharacterTimeContext:()=>({}),buildGroupTimeContext:()=>({}),getPromptTimestampOptionsForTimeContext:()=>({}),stripStateAndInnerForPrompt:v=>v,matchesActiveTags:()=>true});
    vm.runInContext(js(fs.readFileSync(path.join(root,'lib/llm-prompt-assembler.ts'),'utf8'))+';globalThis.assemble={assemblePromptPayload,assembleGroupPromptPayload,formatRichMediaForHistory}',context);
    for(const group of [false,true])for(const chronological of [false,true]){
        const snapshot=structuredClone(shared.cards[0]);snapshot.note.images=snapshot.note.images.map(image=>image.ref?{...image,ref:'data:image/png;base64,'+b64}:image);
        let msg={id:'x',sessionId:'s',role:'assistant',content:'[小红书分享]',mediaType:'xhs_link',mediaData:{xhsNote:snapshot},status:'sent',createdAt:'2026-09-13T00:00:00Z',senderName:'角色'};
        if(group)msg={...msg,content:context.assemble.formatRichMediaForHistory(msg,'用户','角色',true)};
        const input={character:{id:'c',name:'角色'},members:[],memberNames:[],groupName:'群',history:[msg],preset:null,worldBooks:[],regexes:[],timeAware:false,enableVision:true,...(chronological?{unifiedRecentItems:[{kind:'history',historyIndex:0}]}:{})};
        const messages=(group?context.assemble.assembleGroupPromptPayload:context.assemble.assemblePromptPayload)(input);
        const imageMessages=messages.filter(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url'));
        assert.equal(imageMessages.length,1);assert.equal(imageMessages[0].role,'user');assert.match(JSON.stringify(imageMessages),/真实笔记/);assert.match(JSON.stringify(imageMessages),/本次未读取评论/);
    }
    const groupSource=fs.readFileSync(path.join(root,'lib/group-chat-engine.ts'),'utf8');
    const fn=groupSource.slice(groupSource.indexOf('async function appendNativeMediaContext('),groupSource.indexOf('async function runNativeGroupToolLoop('));
    const ctx=vm.createContext({throwIfAborted:()=>{},resolveCompressedImageDataUrl:async url=>url});
    vm.runInContext(js(fn)+';globalThis.append=appendNativeMediaContext',ctx);
    const imageContext=[];await ctx.append(imageContext,[{visionAttachments:shared.images}],true);
    assert.equal(imageContext.length,2);assert.match(JSON.stringify(imageContext),/不是你生成/);assert.match(JSON.stringify(imageContext),/配图|第 3 张/);
    console.log('PASS MCP auth/initialize/list/call, logged-out error, fixed tools, all search candidates, hidden read images, one share card, image order/validation, single/group assistant image history');
} finally {
    globalThis.fetch=realFetch;
    for(const [key,value] of [['XHS_MCP_ACCESS_TOKEN',oldEnv[0]],['XHS_BROWSER_TOKEN',oldEnv[1]]])if(value===undefined)delete process.env[key];else process.env[key]=value;
}
