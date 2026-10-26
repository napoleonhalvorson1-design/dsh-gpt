// Evidence must be fetched for this exact PR head, including every page.
// Approval is a separate Codex decision and is invalidated by any new commit.
const shaPattern=/^[a-f0-9]{40}$/i;
function latest(items,key){const found=new Map();for(const item of items){const k=key(item),old=found.get(k);if(!old||Number(item.id||0)>Number(old.id||0)||Number(item.id||0)===Number(old.id||0)&&Number(item.run_attempt||0)>Number(old.run_attempt||0))found.set(k,item)}return [...found.values()]}
export function githubMergeGate({pullRequest:pr,evidence,expectedHeadSha,approvedHeadSha,requiredChecks=[]}={}){
 const headSha=pr?.head?.sha,reasons=[],failed=[],pending=[];
 if(!shaPattern.test(headSha||''))reasons.push('PR 缺少有效的 head SHA。');
 if(pr?.state!=='open'||pr?.merged||pr?.draft)reasons.push('PR 必须为未合并、非草稿的打开状态。');
 if(pr?.mergeable===false)reasons.push('PR 存在合并冲突。');
 if(expectedHeadSha!==headSha)reasons.push('PR head 已变化，请重新读取和检查。');
 if(evidence?.sha!==headSha||evidence?.complete!==true)reasons.push('CI 证据未完整绑定当前 head SHA。');
 const checks=latest((evidence?.checkRuns||[]).filter(x=>x.head_sha===headSha),x=>(x.app?.id||'')+':'+x.name),runs=latest((evidence?.workflowRuns||[]).filter(x=>x.head_sha===headSha),x=>x.workflow_id+':'+x.event),statuses=latest(evidence?.statuses||[],x=>x.context),passed=new Set();
 for(const c of checks){if(c.status!=='completed')pending.push(c.name);else if(c.conclusion!=='success')failed.push(c.name);else passed.add(c.name)}
 for(const r of runs){const name=r.name||String(r.workflow_id);if(r.status!=='completed')pending.push(name);else if(r.conclusion!=='success')failed.push(name);else passed.add(name)}
 for(const s of statuses){if(s.state==='pending')pending.push(s.context);else if(s.state!=='success')failed.push(s.context);else passed.add(s.context)}
 if(!passed.size&&!pending.length&&!failed.length)reasons.push('当前提交没有实际通过的 CI，不能把空状态当作通过。');
 if(pending.length)reasons.push('CI 尚未完成：'+[...new Set(pending)].join('、'));
 if(failed.length)reasons.push('CI 未通过：'+[...new Set(failed)].join('、'));
 for(const name of requiredChecks)if(!passed.has(name))reasons.push('必要检查尚未通过：'+name);
 const ciPassed=reasons.length===0;
 return {headSha,ciPassed,readyForApproval:ciPassed,canMerge:ciPassed&&approvedHeadSha===headSha,reasons:[...reasons,...(ciPassed&&approvedHeadSha!==headSha?['等待 Codex 批准当前提交。']:[])],checks:checks.length,workflowRuns:runs.length,statuses:statuses.length};
}
