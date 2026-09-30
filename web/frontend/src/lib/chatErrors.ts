export interface ChatErrorDetail { message:string;code?:string;category?:'authentication'|'timeout'|'connection'|'execution';retryable?:boolean;historical?:boolean }
export type ClassifiedChatError = Error & {detail:ChatErrorDetail;status?:number};
export function chatErrorDetail(value:unknown,status?:number):ChatErrorDetail {
 const source=value instanceof Error?(value as Partial<ClassifiedChatError>).detail||{message:value.message}:value;
 const object=source&&typeof source==='object'?source as Record<string,unknown>:{};
 const message=typeof source==='string'?source:typeof object.message==='string'?object.message:typeof object.detail==='string'?object.detail:'请求失败，服务未提供具体原因。';
 const category=['authentication','timeout','connection','execution'].includes(String(object.category))?object.category as ChatErrorDetail['category']:status===401||status===403?'authentication':status===408||status===504?'timeout':undefined;
 return {message,...(typeof object.code==='string'?{code:object.code}:{}),...(category?{category}:{}),...(typeof object.retryable==='boolean'?{retryable:object.retryable}:{})};
}
export function makeChatError(value:unknown,status?:number):ClassifiedChatError {const detail=chatErrorDetail(value,status);return Object.assign(new Error(detail.message),{detail,...(status?{status}:{})});}
export function chatErrorTitle(error:ChatErrorDetail):string {return ({authentication:'认证未通过',timeout:'服务报告超时',connection:'连接失败',execution:'执行失败'} as const)[error.category as NonNullable<ChatErrorDetail['category']>]||'请求未完成';}

/** Recognize only the old gateway's exact leading diagnostic, never a quotation. */
export function historicalGatewayAuthError(content:string):ChatErrorDetail|undefined {
 const diagnostic='gateway agent requires credentials before opening a websocket';
 const value=content.replace(/^Error:[ \t]*/, '');
 if(value!==diagnostic&&!value.startsWith(`${diagnostic}\n`)&&!value.startsWith(`${diagnostic}\r\n`))return undefined;
 // Old diagnostics could contain CLI/env suggestions with secrets. Preserve the
 // saved message, but expose only a fixed, safe explanation in the UI and copy.
 return {message:'当时网关缺少建立连接所需的认证凭据。',code:'gateway_auth_missing',category:'authentication',retryable:false,historical:true};
}
