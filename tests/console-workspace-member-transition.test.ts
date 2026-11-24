// @vitest-environment happy-dom
// B1: real workspace entry, existing poll, current identity reads and owned rollback.
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {hubReadBody} from "./helpers/console-hub-reads";
const $=(id:string)=>document.getElementById(id) as HTMLElement;
const flush=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
const response=(status:number,body:unknown)=>({ok:status<400,status,json:async()=>body});
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return{promise,release};};
const billing=(planName:string,used:number,readOnly=false)=>({plan:planName.toLowerCase(),planName,readOnly,reason:readOnly?"Alpha private trial reason":null,used:{agents:used},seats:1,subscriptionStatus:"active",limits:{maxAgents:10,maxMachines:3,maxProjects:5,maxWebhooks:2,maxWorkspaces:1,retentionDays:90,trialDays:null}});
const identities:Record<string,any>={
 "ws-a":{orgId:"ws-a",orgName:"Alpha Fleet",agentId:"agent-a",agentName:"Alpha Member",role:"operator",memberRole:"owner",workspace:{paused:false},billing:billing("Pro",4,true)},
 "ws-b":{orgId:"ws-b",orgName:"Beta Fleet",agentId:"agent-b",agentName:"Beta Member",role:"agent",memberRole:"member",workspace:{paused:false},billing:billing("Team",9)},
 "ws-c":{orgId:"ws-c",orgName:"Gamma Fleet",agentId:"agent-c",agentName:"Gamma Member",role:"operator",memberRole:"owner",workspace:{paused:false},billing:billing("Business",3)},
};
const person={id:"person-pat",name:"Pat Person",email:"pat@example.test"};
class FakeSocket{static OPEN=1;static CONNECTING=0;readyState=0;onopen=null;onmessage=null;onclose=null;onerror=null;constructor(public url:string){}close(){this.readyState=3;}}
function makeHub(){
 const state={status:new Map<string,number>(),holdBEntry:null as ReturnType<typeof gate>|null,calls:[] as Array<{path:string;ws:string}>};
 const fetchMock=vi.fn(async(path:string,init?:{headers?:Record<string,string>;method?:string})=>{
  const ws=init?.headers?.["X-OpenCadre-Workspace"]??"";state.calls.push({path,ws});
  if(path==="/v1/auth/me")return response(200,{person,workspaces:[{orgId:"ws-a",name:"Alpha Fleet",role:"owner"},{orgId:"ws-b",name:"Beta Fleet",role:"member"},{orgId:"ws-c",name:"Gamma Fleet",role:"owner"}]});
  if(path==="/v1/me"){
   const code=state.status.get(ws)??200;
   const result=response(code,code===200?identities[ws]:{error:"Controlled workspace identity unavailable"});
   if(ws==="ws-b"&&state.holdBEntry){const held=state.holdBEntry;state.holdBEntry=null;await held.promise;}
   return result; // response was captured before the hold; the next poll has independent status
  }
  if(path==="/v1/agents")return response(200,{agents:[]});
  if(path.startsWith("/v1/approvals"))return response(200,{approvals:[]});
  if(path==="/v1/approval-grants")return response(200,{grants:[]});
  if(path.startsWith("/v1/tasks?"))return response(200,{tasks:[],counts:{open:0,expired:0,in_progress:0,needs_review:0,done:0},nextCursor:null,projects:[]});
  if(path.startsWith("/v1/events"))return response(200,{events:[]});
  if(path==="/v1/awareness")return response(200,{items:[],background:{},cursor:0});
  if(path.startsWith("/v1/messages"))return response(200,{messages:[]});
  if(path==="/v1/org/devices")return response(200,{devices:[]});
  if(path.startsWith("/v1/org/sessions"))return response(200,{sessions:[]});
  if(path==="/v1/org/projects")return response(200,{projects:[]});
  return response(200,hubReadBody(path)??{});
 });return{state,fetchMock};
}
function load(fetchMock:ReturnType<typeof makeHub>["fetchMock"]){
 const source=readFileSync(resolve(process.cwd(),"public/app/app.js"),"utf8");
 return new Function("window","document","localStorage","fetch",source+`; return {enterWorkspace,loadAndRender,refreshNow,openSettings:()=>selectTab("settings"),stopPoll:()=>clearTimeout(pollTimer),state:()=>({me,person,currentWorkspace,currentWorkspaceRole,authMode,consoleGeneration,identityTicket})};`)(window,document,localStorage,fetchMock) as any;
}
beforeEach(()=>{
 const html=readFileSync(resolve(process.cwd(),"public/app/index.html"),"utf8").replace(/<link[^>]*>/gi,"").replace(/<script[^>]*>[\s\S]*?<\/script>/gi,"");
 document.documentElement.innerHTML=html;localStorage.clear();sessionStorage.clear();history.replaceState(null,"","/app/");
 vi.useFakeTimers();vi.stubGlobal("WebSocket",FakeSocket);vi.spyOn(console,"warn").mockImplementation(()=>{});
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function signedInA(){const h=makeHub();const c=load(h.fetchMock);await vi.advanceTimersByTimeAsync(0);await c.enterWorkspace("ws-a");await c.refreshNow();await flush();expect(c.state().me.orgId).toBe("ws-a");expect($("org-name").textContent).toBe("Alpha Fleet");expect($("billing-plan").textContent).toContain("Pro");expect($("billing-banner").hidden).toBe(false);expect($("policy-card").hidden).toBe(false);c.openSettings();await flush();expectOwnerAffordances();for(const id of ["members-card","policy-card","projects-card"])for(const link of document.querySelectorAll<HTMLElement>(`[data-settings-section="${id}"]`))expect(link.hidden,id).toBe(false);h.state.calls.length=0;return{...h,c};}
function expectOwnerAffordances(){for(const id of ["policy-card","killswitch-card","members-card","create-agent-key-details"])expect($(id).hidden,id).toBe(false);}
function expectNeutral(c:any){
 for(const id of ["policy-card","killswitch-card","members-card","projects-card","create-agent-key-details"])expect($(id).hidden,id).toBe(true);
 for(const id of ["members-card","policy-card","projects-card"])for(const link of document.querySelectorAll<HTMLElement>(`[data-settings-section="${id}"]`))expect(link.hidden,id).toBe(true);
 expect(c.state().me).toBeNull();expect(c.state().person).toEqual(person);expect(c.state().authMode).toBe("session");
 expect($("org-name").textContent).toBe("");expect($("overview-subtitle").textContent).toBe("");expect($("ws-avatar").textContent).toBe("?");expect($("ws-plan").hidden).toBe(true);expect($("ws-plan").textContent).toBe("");
 expect($("whoami").textContent).toBe(person.name);expect($("user-menu-name").textContent).toBe(person.name);expect($("user-menu-email").textContent).toBe(person.email);
 for(const id of ["billing-plan","billing-usage","billing-banner-title","billing-banner-meta","billing-banner-action","sidebar-alert-title","sidebar-alert-meta","sidebar-alert-action"])expect($(id).textContent,id).toBe("");
 for(const id of ["billing-banner","sidebar-alert"]){expect($(id).hidden,id).toBe(true);expect($(id).dataset.tone,id).toBeUndefined();}
}
function expectNoRoleReads(state:ReturnType<typeof makeHub>["state"]){expect(state.calls.filter(x=>x.path.endsWith("/members")||["/v1/onboarding","/v1/push/devices"].includes(x.path))).toEqual([]);}
function expectB(c:any){
 expect($("create-agent-key-details").hidden).toBe(false);
 expect(c.state().me).toMatchObject({orgId:"ws-b",role:"agent",memberRole:"member"});expect(c.state().currentWorkspaceRole).toBe("member");
 expect($("org-name").textContent).toBe("Beta Fleet");expect($("ws-plan").textContent).toBe("Team");expect($("billing-plan").textContent).toBe("Team");expect($("billing-usage").textContent).toContain("9 of 10");
 expect($("policy-card").hidden).toBe(true);expect($("killswitch-card").hidden).toBe(true);expect($("members-card").hidden).toBe(true);expect($("org-key-field").hidden).toBe(false);expect(($("org-key") as HTMLInputElement).required).toBe(true);
 expect($("whoami").textContent).toBe(person.name);expect($("billing-banner").hidden).toBe(true);expect($("sidebar-alert").hidden).toBe(true);
}
describe("workspace member identity staging",()=>{
 it("keeps failed B entry withdrawn through a subsequent B500 and applies recovered B role and controls",async()=>{
  const{state,c}=await signedInA();state.status.set("ws-b",500);await expect(c.enterWorkspace("ws-b")).rejects.toThrow();
  expect($("billing-plan").textContent).toBe("");await c.refreshNow();expect($("billing-plan").textContent).toBe("");expectNeutral(c);expectNoRoleReads(state);
  state.status.delete("ws-b");await c.refreshNow();expectB(c);c.stopPoll();
 });
 it("withdraws A immediately while B entry is held and an existing poll for B fails, then accepts held B",async()=>{
  const{state,c}=await signedInA();const held=gate();state.holdBEntry=held;const entry=c.enterWorkspace("ws-b");await flush();
  expectNeutral(c);expectNoRoleReads(state);state.status.set("ws-b",500);await vi.advanceTimersByTimeAsync(4000);await flush();
  expect(state.calls.filter(x=>x.path==="/v1/me"&&x.ws==="ws-b").length).toBeGreaterThanOrEqual(2);expectNeutral(c);expectNoRoleReads(state);
  held.release();await entry;state.status.delete("ws-b");await c.refreshNow();expectB(c);c.stopPoll();
 });
 it("only an owned unwanted entry restores the local A snapshot even if A reload fails",async()=>{
  const{state,c}=await signedInA();const held=gate();state.holdBEntry=held;let wanted=true;
  const entry=c.enterWorkspace("ws-b",{wanted:()=>wanted});await flush();wanted=false;state.status.set("ws-a",500);held.release();await entry;await c.refreshNow();
  expect(c.state().me.orgId).toBe("ws-a");expect(c.state().currentWorkspace).toBe("ws-a");expect(c.state().person).toEqual(person);
  expect($("org-name").textContent).toBe("Alpha Fleet");expect($("ws-plan").textContent).toBe("Read-only");expect($("billing-plan").textContent).toContain("Pro");expect($("billing-banner-meta").textContent).toContain("Alpha private trial reason");expect($("billing-banner").hidden).toBe(false);expect($("sidebar-alert").hidden).toBe(false);expectOwnerAffordances();c.stopPoll();
 });
 it("a newer C entry prevents the old held B result and unwanted rollback from replacing C",async()=>{
  const{state,c}=await signedInA();const held=gate();state.holdBEntry=held;let wanted=true;let oldSettled=false;
  void c.enterWorkspace("ws-b",{wanted:()=>wanted}).then(()=>{oldSettled=true;});await flush();wanted=false;await c.enterWorkspace("ws-c");await c.refreshNow();const generation=c.state().consoleGeneration;
  held.release();await flush();expect(oldSettled).toBe(false);expect(c.state().consoleGeneration).toBe(generation);expect(c.state().me.orgId).toBe("ws-c");expect(c.state().currentWorkspace).toBe("ws-c");expect($("org-name").textContent).toBe("Gamma Fleet");expect($("billing-plan").textContent).toBe("Business");expectOwnerAffordances();c.stopPoll();
 });
 it("a transient500 in already-authorized A keeps A identity, plan and paid-owner controls",async()=>{
  const{state,c}=await signedInA();state.status.set("ws-a",500);await c.refreshNow();
  expect(c.state().me.orgId).toBe("ws-a");expect(c.state().person).toEqual(person);expect($("org-name").textContent).toBe("Alpha Fleet");expect($("billing-plan").textContent).toContain("Pro");expect($("billing-banner").hidden).toBe(false);expect($("policy-card").hidden).toBe(false);expectOwnerAffordances();c.stopPoll();
 });
});
