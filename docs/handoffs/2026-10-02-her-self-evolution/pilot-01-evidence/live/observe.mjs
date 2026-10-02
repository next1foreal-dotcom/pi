import {execFileSync} from "node:child_process";
import {readFileSync,mkdtempSync,writeFileSync} from "node:fs";
import {join} from "node:path";
const git="C:\\Program Files\\Git\\cmd\\git.exe";
const request=JSON.parse(readFileSync(0,"utf8"));
if(request.preconditions) {
 // Natural-language scope cannot be verified by keyword matching; report unknown facts explicitly.
 console.log(JSON.stringify({status:"unknown",facts:{os:process.platform,environment:request.task.environment,inputKind:request.task.input?.kind},preconditions:request.preconditions}));process.exit(0);
}
function observe(input) {
if(input.kind==="text-pair" || input.kind==="binary-pair") {
 if(input.kind==="binary-pair") {
  if(![input.leftHex,input.rightHex].every(v=>typeof v==="string" && /^(?:[0-9a-fA-F]{2}){1,6000}$/.test(v)))throw new Error("bounded hex required");
  writeFileSync(join(process.cwd(),"left.bin"),Buffer.from(input.leftHex,"hex"));writeFileSync(join(process.cwd(),"right.bin"),Buffer.from(input.rightHex,"hex"));
  return {value:{equal:readFileSync(join(process.cwd(),"left.bin")).equals(readFileSync(join(process.cwd(),"right.bin")))},facts:{input}};
 }
 if(typeof input.left!=="string" || typeof input.right!=="string" || input.left.length+input.right.length>12000 || !["literal","normalize-lf","case-insensitive"].includes(input.rule))throw new Error("bounded text comparison required");
 writeFileSync(join(process.cwd(),"left.txt"),input.left);writeFileSync(join(process.cwd(),"right.txt"),input.right);
 const view=t=>input.rule==="normalize-lf"?t.replaceAll("\r\n","\n"):input.rule==="case-insensitive"?t.toLowerCase():t;
 return {value:{equal:view(readFileSync(join(process.cwd(),"left.txt"),"utf8"))===view(readFileSync(join(process.cwd(),"right.txt"),"utf8"))},facts:{input}};
}
if(input.kind!=="git-status"&&input.kind!=="text-view")throw new Error("operation supports git-status or text-view data only");
let facts;
if(input.kind==="git-status") {
 if(typeof input.checkoutAutocrlf!=="boolean"||!["inherit","sanitized"].includes(input.readerConfig)||!["LF","CRLF"].includes(input.newline))throw new Error("unsupported Git observation parameters");
 const dir=mkdtempSync(join(process.cwd(),"fixture-"));
 const checkoutEnv={GIT_CONFIG_COUNT:"1",GIT_CONFIG_KEY_0:"core.autocrlf",GIT_CONFIG_VALUE_0:String(input.checkoutAutocrlf)};
 const run=(args,env=checkoutEnv)=>execFileSync(git,["-C",dir,...args],{encoding:"utf8",env,windowsHide:true});
 run(["init","-q"]);run(["config","user.name","Growth isolated observer"]);run(["config","user.email","growth-observer@her.local"]);
 const content=input.content??"alpha\nbeta\n";
 if(typeof content!=="string"||content.length>12000)throw new Error("bounded content required");
 writeFileSync(join(dir,"sample.md"),input.newline==="CRLF"?content.replaceAll("\r\n","\n").replaceAll("\n","\r\n"):content.replaceAll("\r\n","\n"));
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
const value=input.kind==="git-status"?{dirty:facts.dirty}:{equal:facts.equal};
return {value,facts};
}
if(Array.isArray(request.cases)) {
 if(request.cases.length<1||request.cases.length>4)throw new Error("1..4 observations per experiment");
 console.log(JSON.stringify({observations:request.cases.map(observe)}));
} else {
 const result=observe(request.task?.input??request);
 console.log(JSON.stringify({...result,value:request.answer??result.value}));
}