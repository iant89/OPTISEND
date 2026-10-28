/**
 * SANDBOX-ONLY minimal React typings.
 *
 * The build sandbox had no access to the npm registry, so @types/react was
 * unavailable. This shim lets `npm run typecheck:sandbox` check the app with
 * the subset of React used here. On a normal machine, `npm install` provides
 * the real @types/react and the default `npm run typecheck` uses those —
 * this file is excluded there.
 */
declare module 'react' {
  export type ReactNode = ReactElement | string | number | boolean | null | undefined | Iterable<ReactNode>;
  export interface ReactElement { type: unknown; props: unknown; key: string | null }
  export type Key = string | number;
  export type SetStateAction<S> = S | ((prev: S) => S);
  export type Dispatch<A> = (value: A) => void;
  export interface RefObject<T> { current: T }
  export type DependencyList = readonly unknown[];
  export type FC<P = {}> = (props: P) => ReactNode;
  export interface CSSProperties { [key: string]: string | number | undefined }

  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useEffect(effect: () => void | (() => void), deps?: DependencyList): void;
  export function useLayoutEffect(effect: () => void | (() => void), deps?: DependencyList): void;
  export function useRef<T>(initial: T): RefObject<T>;
  export function useMemo<T>(factory: () => T, deps: DependencyList): T;
  export function useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: DependencyList): T;
  export function useId(): string;
  export function useSyncExternalStore<T>(subscribe: (cb: () => void) => () => void, get: () => T): T;
  export const StrictMode: FC<{ children?: ReactNode }>;
  export const Fragment: FC<{ children?: ReactNode }>;

  interface SyntheticEvent<T = Element, E = Event> {
    currentTarget: T;
    target: EventTarget & T;
    nativeEvent: E;
    preventDefault(): void;
    stopPropagation(): void;
  }
  export type ChangeEvent<T = Element> = SyntheticEvent<T>;
  export type FormEvent<T = Element> = SyntheticEvent<T>;
  export type MouseEvent<T = Element> = SyntheticEvent<T, globalThis.MouseEvent>;
  export interface DragEvent<T = Element> extends SyntheticEvent<T, globalThis.DragEvent> { dataTransfer: DataTransfer }
  export interface KeyboardEvent<T = Element> extends SyntheticEvent<T, globalThis.KeyboardEvent> { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }
}

declare module 'react/jsx-runtime' {
  export const jsx: unknown;
  export const jsxs: unknown;
  export const Fragment: unknown;
}

declare module 'react-dom/client' {
  import type { ReactNode } from 'react';
  export interface Root { render(node: ReactNode): void; unmount(): void }
  export function createRoot(el: Element): Root;
}

declare namespace JSX {
  type Element = import('react').ReactElement;
  interface ElementChildrenAttribute { children: {} }
  interface IntrinsicAttributes { key?: import('react').Key }
  interface IntrinsicElements { [tag: string]: any }
}
