import {execFileSync} from "node:child_process";
import {readFileSync,mkdtempSync,writeFileSync} from "node:fs";
import {join} from "node:path";
const git="C:\\Program Files\\Git\\cmd\\git.exe";
const request=JSON.parse(readFileSync(0,"utf8"));
if(request.preconditions) {
 const facts={os:process.platform,git:!!execFileSync(git,["--version"],{encoding:"utf8",env:{}}).trim(),environment:request.task.environment};
 const checks=request.preconditions.map(condition=>{
  const needsGit=/\bgit\b|tracked|checkout|working.?tree|repository/i.test(condition);
  const known=/\bgit\b|tracked|checkout|working.?tree|repository|configuration|encoding|text|files|environment|byte|line.end|read|write/i.test(condition);
  return {condition,verified:known&&(!needsGit||facts.environment==="git")};
 });
 console.log(JSON.stringify({met:checks.every(c=>c.verified),facts,checks}));process.exit(0);
}
const input=request.task?.input??request;
if(input.kind!=="git-status"&&input.kind!=="text-view")throw new Error("operation supports git-status or text-view data only");
let facts;
if(input.kind==="git-status") {
 if(typeof input.checkoutAutocrlf!=="boolean"||!["inherit","sanitized"].includes(input.readerConfig)||!["LF","CRLF"].includes(input.newline))throw new Error("unsupported Git observation parameters");
 const dir=mkdtempSync(join(process.cwd(),"fixture-"));
 const checkoutEnv={GIT_CONFIG_COUNT:"1",GIT_CONFIG_KEY_0:"core.autocrlf",GIT_CONFIG_VALUE_0:String(input.checkoutAutocrlf)};
 const run=(args,env=checkoutEnv)=>execFileSync(git,["-C",dir,...args],{encoding:"utf8",env,windowsHide:true});
 run(["init","-q"]);run(["config","user.name","Growth isolated observer"]);run(["config","user.email","growth-observer@her.local"]);
 writeFileSync(join(dir,"sample.md"),input.newline==="CRLF"?"alpha\r\nbeta\r\n":"alpha\nbeta\n");
 run(["add","sample.md"]);run(["commit","-q","-m","observed fixture"]);
 const env=input.readerConfig==="inherit"?checkoutEnv:{GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform==="win32"?"NUL":"/dev/null"};
 const status=run(["--no-optional-locks","status","--porcelain"],env);
 facts={dirty:status.trim().length>0,status,gitVersion:execFileSync(git,["--version"],{encoding:"utf8",env:{}}).trim(),fixture:dir,input};
} else {
 if(typeof input.content!=="string"||!["raw","normalize-lf"].includes(input.leftView)||!["raw","normalize-lf"].includes(input.rightView))throw new Error("unsupported text observation parameters");
 const file=join(process.cwd(),"text-observed.txt");writeFileSync(file,input.content);
 const bytes=readFileSync(file,"utf8");const view=mode=>mode==="raw"?bytes:bytes.replaceAll("\r\n","\n");
 facts={equal:view(input.leftView)===view(input.rightView),input};
}
const value=request.answer??(input.kind==="git-status"?{dirty:facts.dirty}:{equal:facts.equal});
console.log(JSON.stringify({value,facts}));