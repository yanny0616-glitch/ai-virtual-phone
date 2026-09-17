import assert from "node:assert/strict";
import test from "node:test";
import { applyChatState } from "../src/chat-state.ts";
const nowMs = Date.parse("2026-09-16T15:00:00+08:00");
const opts = { nowMs, tz: 480, date: "2026-09-16", chatEditsDay: true };
const day = { mood:"平静", conds: [{mood:"很旧",startAt:nowMs-86400000,halfLifeMin:10}], schedule:[
  {time:"14:00",end:"16:00",title:"开会"}, {time:"18:00",end:"19:00",title:"吃饭",steps:[{time:"18:10",what:"做饭"}]}, {time:"20:00",end:"21:00",title:"健身"},
] };

test("聊天情绪衰减原料落库，不改底色；新情绪限幅并清理旧状态", () => {
 const r=applyChatState(day,{mood:"难过",cause:"吵架",energy:-99,intensity:180,hours:99},[],opts);
 assert.equal(r.day.mood,"平静");assert.deepEqual(r.day.conds,[{mood:"难过",cause:"吵架",energyDelta:-20,intensity:100,halfLifeMin:720,startAt:nowMs}]);
 assert.equal(day.conds[0].mood,"很旧");
});
test("只改未来：移动保留时长并清理旧细排，删除未来日程", () => {
 const r=applyChatState(day,null,[{op:"move",time:"18:00",newTime:"19:00"},{op:"drop",time:"20:00"}],opts);
 assert.equal(r.day.schedule!.length,2);assert.equal(r.day.schedule![1].time,"19:00");assert.equal(r.day.schedule![1].end,"20:00");assert.equal(r.day.schedule![1].steps,undefined);
});
test("关日程开关仍更新情绪；拒绝改过去、时间冲突和跨午夜", () => {
 assert.deepEqual(applyChatState(day,{mood:"开心"},[{op:"drop",time:"20:00"}],{...opts,chatEditsDay:false}).day.schedule,day.schedule);
 for (const edit of [{op:"drop",time:"14:00"},{op:"move",time:"18:00",newTime:"23:30"},{op:"add",newTime:"20:00",title:"撞点"},{op:"add",newTime:"29:99",title:"无效"}]) assert.deepEqual(applyChatState(day,null,[edit],opts).day.schedule,day.schedule);
 assert.equal(applyChatState(day,{mood:"开心"},[],{...opts,date:"2026-09-15"}).notes.length,0);
});
