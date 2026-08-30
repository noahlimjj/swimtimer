import { spawnSync, spawn } from "node:child_process";
import path from "node:path";
import * as tf from "@tensorflow/tfjs-node";
import * as pd from "@tensorflow-models/pose-detection";
import { squareLetterbox, mapKeypoints } from "/Users/User/swim_timer/src/dive-pose.js";
const W=480,H=854, MODEL="file://"+path.resolve("/Users/User/swim_timer/public/models/movenet/model.json");
function pts(clip){return spawnSync("ffprobe",["-v","error","-select_streams","v:0","-show_entries","frame=best_effort_timestamp_time","-of","csv=p=0",clip],{encoding:"utf8",maxBuffer:1<<26}).stdout.trim().split("\n").map(parseFloat).filter(Number.isFinite);}
function dur(clip){return parseFloat(spawnSync("ffprobe",["-v","error","-select_streams","v:0","-show_entries","stream=duration","-of","csv=p=0",clip],{encoding:"utf8"}).stdout);}
function decodeAll(clip,P,times){return new Promise((res,rej)=>{const fb=W*H*3;const ff=spawn("ffmpeg",["-v","error","-i",clip,"-vf",`scale=${W}:${H},format=rgb24`,"-f","rawvideo","-pix_fmt","rgb24","-"]);let acc=Buffer.alloc(0),idx=0;const out=[];const want=new Set();let ti=0;
ff.stdout.on("data",c=>{acc=acc.length?Buffer.concat([acc,c]):c;while(acc.length>=fb){const fr=acc.subarray(0,fb);acc=acc.subarray(fb);const t=P[idx]??idx/30; while(ti<times.length && t>=times[ti]){ out.push({t,buf:Buffer.from(fr)}); ti++; } idx++;}});
let e="";ff.stderr.on("data",d=>e+=d);ff.on("close",cd=>cd===0?res(out):rej(new Error(e)));});}
const det=await pd.createDetector(pd.SupportedModels.MoveNet,{modelType:pd.movenet.modelType.SINGLEPOSE_LIGHTNING,modelUrl:MODEL});
const {side,offX,offY}=squareLetterbox(W,H);
async function est(buf){const r=tf.tidy(()=>tf.tensor3d(new Uint8Array(buf),[H,W,3],"int32").pad([[Math.floor(offY),Math.ceil(offY)],[Math.floor(offX),Math.ceil(offX)],[0,0]]));const p=await det.estimatePoses(r,{maxPoses:1});r.dispose();if(!p.length)return{s:0,ay:null};const kp=mapKeypoints(p[0].keypoints,offX,offY);let y=0,w=0;for(const n of["left_ankle","right_ankle"]){const k=kp[n];if(k&&k.score>0.2){y+=k.y*k.score;w+=k.score;}}return{s:p[0].score??0,ay:w?y/w:null};}
for(const name of process.argv.slice(2)){
 const clip=`/Users/User/Downloads/files/${name}.mov`; const P=pts(clip); const D=dur(clip);
 const times=[];for(let t=0;t<D;t+=1.3)times.push(t);
 const frames=await decodeAll(clip,P,times);
 let out=`\n=== ${name}  dur=${D.toFixed(1)} ===\n`;
 for(const f of frames){const r=await est(f.buf);out+=` t=${f.t.toFixed(2)} s=${r.s.toFixed(2)} ankleY=${r.ay==null?"  .  ":r.ay.toFixed(0)}\n`;}
 console.log(out);
}
