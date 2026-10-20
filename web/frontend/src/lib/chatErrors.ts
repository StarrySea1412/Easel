export interface ChatErrorDetail { message:string;code?:string;category?:'authentication'|'timeout'|'connection'|'execution'|'configuration';retryable?:boolean;historical?:boolean;detail?:string;channel?:string;channelEndpoint?:string;modelRef?:string;stage?:string }
export type ClassifiedChatError = Error & {detail:ChatErrorDetail;status?:number};
export function chatErrorDetail(value:unknown,status?:number):ChatErrorDetail {
 const source=value instanceof Error?(value as Partial<ClassifiedChatError>).detail||{message:value.message}:value;
 const object=source&&typeof source==='object'?source as Record<string,unknown>:{};
 const message=typeof source==='string'?source:typeof object.message==='string'?object.message:typeof object.detail==='string'?object.detail:'请求失败，服务未提供具体原因。';
 const category=['authentication','timeout','connection','execution','configuration'].includes(String(object.category))?object.category as ChatErrorDetail['category']:status===401||status===403?'authentication':status===408||status===504?'timeout':undefined;
 const aborted=object.code==='agent_execution_failed' && (object.detail==='aborted' || /返回原因[：:]\s*aborted\s*$/.test(message));
 const upstreamDetail=typeof object.detail==='string'?object.detail:'';
 const providerConcurrencyLimit=object.code==='agent_execution_failed' && /^\s*(?:HTTP(?:\/[0-9.]+)?\s*)?429\b/i.test(upstreamDetail) && /(?:并发请求数限制|最多同时处理\s*1个请求)/.test(upstreamDetail);
 const normalized=aborted?'网关报告本轮请求被中断（aborted），没有提供中断原因。已保留收到的内容；请查看运行记录中的本轮失败详情，确认后手动重试。':providerConcurrencyLimit?'服务商拒绝了请求：当前渠道最多同时处理1个任务。Easel 已对同渠道任务排队；其他应用仍可能占用同一 Key。原失败轮次不会自动重发。':message;
 const diagnostics=Object.fromEntries(['detail','channel','channelEndpoint','modelRef','stage'].filter(key=>typeof object[key]==='string').map(key=>[key, String(object[key]).slice(0,600)]));
 return {...diagnostics,message:normalized,...(typeof object.code==='string'?{code:aborted?'agent_request_aborted':providerConcurrencyLimit?'model_rate_limited':object.code}:{}),...(category?{category}:{}),...(typeof object.retryable==='boolean'?{retryable:object.retryable}:{})};
}
export function makeChatError(value:unknown,status?:number):ClassifiedChatError {const detail=chatErrorDetail(value,status);return Object.assign(new Error(detail.message),{detail,...(status?{status}:{})});}
export function chatErrorTitle(error:ChatErrorDetail):string {return error.code==='model_stream_interrupted'?'模型响应中断':error.code==='agent_request_aborted'?'请求被中断':error.code==='chat_channel_busy'?'渠道排队超时':error.code==='model_rate_limited'?'服务商限流':error.code==='thinking_level_unsupported'?'思考档位不支持':({authentication:'认证未通过',timeout:'服务报告超时',connection:'连接失败',execution:'执行失败',configuration:'配置不匹配'} as const)[error.category as NonNullable<ChatErrorDetail['category']>]||'请求未完成';}

/** Recognize only the old gateway's exact leading diagnostic, never a quotation. */
export function historicalGatewayAuthError(content:string):ChatErrorDetail|undefined {
 const diagnostic='gateway agent requires credentials before opening a websocket';
 const value=content.replace(/^Error:[ \t]*/, '');
 if(value!==diagnostic&&!value.startsWith(`${diagnostic}\n`)&&!value.startsWith(`${diagnostic}\r\n`))return undefined;
 // Old diagnostics could contain CLI/env suggestions with secrets. Preserve the
 // saved message, but expose only a fixed, safe explanation in the UI and copy.
 return {message:'当时网关缺少建立连接所需的认证凭据。',code:'gateway_auth_missing',category:'authentication',retryable:false,historical:true};
}
