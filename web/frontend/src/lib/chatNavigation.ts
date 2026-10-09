import type { ChatMessage } from './store';
export interface ChatTurnNode { messageIndex:number;number:number;label:string;reply?:string }
const excerpt = (text:string) => text.replace(/<[^>]*>/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(?:^|\n)\s{0,3}#{1,6}\s/g, ' ').replace(/[*`~]/g, '').replace(/\s+/g, ' ').trim().slice(0,240);
export function chatTurnNodes(messages:Pick<ChatMessage,'role'|'content'|'attachments'>[], liveReply=''):ChatTurnNode[] {
 const nodes:ChatTurnNode[]=[];
 for(let messageIndex=0;messageIndex<messages.length;messageIndex++) {
  const message=messages[messageIndex];
  if(message.role==='user')nodes.push({messageIndex,number:nodes.length+1,label:message.content.replace(/\s+/g,' ').trim()||(message.attachments?.length?`附件创作（${message.attachments.length} 个附件）`:'未填写文字的请求')});
  else if(message.role==='assistant'&&nodes.length){const reply=excerpt(message.content);if(reply)nodes[nodes.length-1].reply=reply;}
 }
 const live=excerpt(liveReply);if(live&&nodes.length)nodes[nodes.length-1].reply=live;
 return nodes;
}
export function activeTurnFromOffsets(offsets:number[],scrollTop:number,atBottom:boolean,lead=72):number {
 if(!offsets.length)return -1;if(atBottom)return offsets.length-1;
 let active=0;for(let i=0;i<offsets.length;i++){if(offsets[i]<=scrollTop+lead)active=i;else break;}return active;
}
export function isChatAtBottom(scrollTop:number,scrollHeight:number,clientHeight:number,tolerance=48):boolean { return scrollHeight-clientHeight-scrollTop<=tolerance; }

export function shouldFollowChatScroll(wasFollowing:boolean,previousTop:number,nextTop:number,scrollHeight:number,clientHeight:number,navigating=false):boolean {
 // A node jump can end within the bottom threshold. It is still an explicit
 // request to read that turn, not a request to resume following the stream.
 if(navigating)return false;
 const atBottom=isChatAtBottom(nextTop,scrollHeight,clientHeight);
 if(nextTop<previousTop-1||!atBottom)return false;
 if(nextTop>previousTop+1&&atBottom)return true;
 return wasFollowing;
}
