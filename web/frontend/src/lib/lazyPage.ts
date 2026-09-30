import { createElement, lazy, Suspense, useState } from 'react';
import type { ComponentType } from 'react';
import { PageBoundary, PageLoading } from '../components/LazyPage';

type Loader<Props extends object> = () => Promise<{ default: ComponentType<Props> }>;

/** Replace a rejected lazy promise on retry, while retaining App's controllers. */
export function createLazyPage<Props extends object>(label: string, load: Loader<Props>) {
  return function DeferredPage(props: Props) {
    const [Loaded, setLoaded] = useState(() => lazy(load));
    const [attempt, setAttempt] = useState(0);
    const retry = () => {
      setLoaded(() => lazy(load));
      setAttempt(value => value + 1);
    };
    return createElement(PageBoundary, { key: attempt, label, onRetry: retry },
      createElement(Suspense, { fallback: createElement(PageLoading, { label }) },
        createElement(Loaded, props)));
  };
}
