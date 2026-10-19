import { useId } from 'react';
import type { OfficeActionKind } from '../lib/agentOffice';
import type { OfficeObservedModel } from '../lib/modelProviders';
import { modelProvider } from '../lib/modelProviders';
import { ObservedProviderIcon } from './ProviderIcon';
import { IconFile, IconEdit, IconTerminal, IconImage, IconChat, IconSkills, IconCheck, IconStop } from './icons';

export function OpenClawIcon({size=22}:{size?:number}) {
  const id='lobster-'+useId().replace(/:/g,'');
  return <svg width={size} height={size} viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id={id} x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#ff4d4d"/><stop offset="100%" stopColor="#991b1b"/></linearGradient></defs><path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill={`url(#${id})`}/><path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" fill={`url(#${id})`}/><path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" fill={`url(#${id})`}/><path d="M45 15 Q35 5 30 8M75 15 Q85 5 90 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round"/><circle cx="45" cy="35" r="6" fill="#050810"/><circle cx="75" cy="35" r="6" fill="#050810"/><circle cx="46" cy="34" r="2.5" fill="#00e5cc"/><circle cx="76" cy="34" r="2.5" fill="#00e5cc"/></svg>;
}
export function AgentActionIcon({kind,size=15}:{kind:OfficeActionKind;size?:number}) {
  const Icon=kind==='reading'?IconFile:kind==='writing'?IconEdit:kind==='designing'?IconImage:kind==='executing'?IconTerminal:kind==='delegating'?IconChat:kind==='completed'?IconCheck:kind==='stopped'?IconStop:IconSkills;
  return <Icon size={size}/>;
}
export function ModelIdentityLabel({identity,showChannel=true}:{identity?:OfficeObservedModel;showChannel?:boolean}) {
  const observed=identity?.source==='observed'&&identity.model;
  const provider=modelProvider(observed?identity.provider:undefined);
  return <span className="agent-model-label" title={observed?identity.evidence:'等待运行服务上报模型身份'}><span className="agent-provider-mark" style={{color:provider.color}} aria-hidden="true"><ObservedProviderIcon provider={provider.id}/></span><span>{observed?identity.model:'模型未上报'}</span>{showChannel&&<small>渠道：{observed&&identity.channel?identity.channel:'未上报'}</small>}</span>;
}
