/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactElement} from 'shared/ReactElementType';
import type {
  ReactPortal,
  Thenable,
  ReactContext,
  ReactDebugInfo,
} from 'shared/ReactTypes';
import type {Fiber} from './ReactInternalTypes';
import type {Lanes} from './ReactFiberLane';
import type {ThenableState} from './ReactFiberThenable';

import getComponentNameFromFiber from 'react-reconciler/src/getComponentNameFromFiber';
import {
  Placement,
  ChildDeletion,
  Forked,
  PlacementDEV,
} from './ReactFiberFlags';
import {
  getIteratorFn,
  ASYNC_ITERATOR,
  REACT_ELEMENT_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_PORTAL_TYPE,
  REACT_LAZY_TYPE,
  REACT_CONTEXT_TYPE,
  REACT_LEGACY_ELEMENT_TYPE,
} from 'shared/ReactSymbols';
import {
  HostRoot,
  HostText,
  HostPortal,
  Fragment,
  FunctionComponent,
} from './ReactWorkTags';
import isArray from 'shared/isArray';
import {
  enableRefAsProp,
  enableAsyncIterableChildren,
} from 'shared/ReactFeatureFlags';

import {
  createWorkInProgress,
  resetWorkInProgress,
  createFiberFromElement,
  createFiberFromFragment,
  createFiberFromText,
  createFiberFromPortal,
} from './ReactFiber';
import {isCompatibleFamilyForHotReloading} from './ReactFiberHotReloading';
import {getIsHydrating} from './ReactFiberHydrationContext';
import {pushTreeFork} from './ReactFiberTreeContext';
import {createThenableState, trackUsedThenable} from './ReactFiberThenable';
import {readContextDuringReconciliation} from './ReactFiberNewContext';

// This tracks the thenables that are unwrapped during reconcilation.
let thenableState: ThenableState | null = null;
let thenableIndexCounter: number = 0;

function mergeDebugInfo(
  outer: ReactDebugInfo | null,
  inner: ReactDebugInfo | null | void,
): ReactDebugInfo | null {
  if (!__DEV__) {
    return null;
  }
  if (inner == null) {
    return outer;
  } else if (outer === null) {
    return inner;
  } else {
    // If we have two debugInfo, we need to create a new one. This makes the array no longer
    // live so we'll miss any future updates if we received more so ideally we should always
    // do this after both have fully resolved/unsuspended.
    return outer.concat(inner);
  }
}

let didWarnAboutMaps;
let didWarnAboutGenerators;
let ownerHasKeyUseWarning;
let ownerHasFunctionTypeWarning;
let ownerHasSymbolTypeWarning;
let warnForMissingKey = (child: mixed, returnFiber: Fiber) => {};

if (__DEV__) {
  didWarnAboutMaps = false;
  didWarnAboutGenerators = false;

  /**
   * Warn if there's no key explicitly set on dynamic arrays of children or
   * object keys are not valid. This allows us to keep track of children between
   * updates.
   */
  ownerHasKeyUseWarning = ({}: {[string]: boolean});
  ownerHasFunctionTypeWarning = ({}: {[string]: boolean});
  ownerHasSymbolTypeWarning = ({}: {[string]: boolean});

  warnForMissingKey = (child: mixed, returnFiber: Fiber) => {
    if (child === null || typeof child !== 'object') {
      return;
    }
    if (!child._store || child._store.validated || child.key != null) {
      return;
    }

    if (typeof child._store !== 'object') {
      throw new Error(
        'React Component in warnForMissingKey should have a _store. ' +
          'This error is likely caused by a bug in React. Please file an issue.',
      );
    }

    // $FlowFixMe[cannot-write] unable to narrow type from mixed to writable object
    child._store.validated = true;

    const componentName = getComponentNameFromFiber(returnFiber) || 'Component';

    if (ownerHasKeyUseWarning[componentName]) {
      return;
    }
    ownerHasKeyUseWarning[componentName] = true;

    console.error(
      'Each child in a list should have a unique ' +
        '"key" prop. See https://react.dev/link/warning-keys for ' +
        'more information.',
    );
  };
}

function unwrapThenable<T>(thenable: Thenable<T>): T {
  const index = thenableIndexCounter;
  thenableIndexCounter += 1;
  if (thenableState === null) {
    thenableState = createThenableState();
  }
  return trackUsedThenable(thenableState, thenable, index);
}

function coerceRef(
  returnFiber: Fiber,
  current: Fiber | null,
  workInProgress: Fiber,
  element: ReactElement,
): void {
  let ref;
  if (enableRefAsProp) {
    // TODO: This is a temporary, intermediate step. When enableRefAsProp is on,
    // we should resolve the `ref` prop during the begin phase of the component
    // it's attached to (HostComponent, ClassComponent, etc).
    const refProp = element.props.ref;
    ref = refProp !== undefined ? refProp : null;
  } else {
    // Old behavior.
    ref = element.ref;
  }

  // TODO: If enableRefAsProp is on, we shouldn't use the `ref` field. We
  // should always read the ref from the prop.
  workInProgress.ref = ref;
}

function throwOnInvalidObjectType(returnFiber: Fiber, newChild: Object) {
  if (newChild.$$typeof === REACT_LEGACY_ELEMENT_TYPE) {
    throw new Error(
      'A React Element from an older version of React was rendered. ' +
        'This is not supported. It can happen if:\n' +
        '- Multiple copies of the "react" package is used.\n' +
        '- A library pre-bundled an old copy of "react" or "react/jsx-runtime".\n' +
        '- A compiler tries to "inline" JSX instead of using the runtime.',
    );
  }

  // $FlowFixMe[method-unbinding]
  const childString = Object.prototype.toString.call(newChild);

  throw new Error(
    `Objects are not valid as a React child (found: ${
      childString === '[object Object]'
        ? 'object with keys {' + Object.keys(newChild).join(', ') + '}'
        : childString
    }). ` +
      'If you meant to render a collection of children, use an array ' +
      'instead.',
  );
}

function warnOnFunctionType(returnFiber: Fiber, invalidChild: Function) {
  if (__DEV__) {
    const parentName = getComponentNameFromFiber(returnFiber) || 'Component';

    if (ownerHasFunctionTypeWarning[parentName]) {
      return;
    }
    ownerHasFunctionTypeWarning[parentName] = true;

    const name = invalidChild.displayName || invalidChild.name || 'Component';

    if (returnFiber.tag === HostRoot) {
      console.error(
        'Functions are not valid as a React child. This may happen if ' +
          'you return %s instead of <%s /> from render. ' +
          'Or maybe you meant to call this function rather than return it.\n' +
          '  root.render(%s)',
        name,
        name,
        name,
      );
    } else {
      console.error(
        'Functions are not valid as a React child. This may happen if ' +
          'you return %s instead of <%s /> from render. ' +
          'Or maybe you meant to call this function rather than return it.\n' +
          '  <%s>{%s}</%s>',
        name,
        name,
        parentName,
        name,
        parentName,
      );
    }
  }
}

function warnOnSymbolType(returnFiber: Fiber, invalidChild: symbol) {
  if (__DEV__) {
    const parentName = getComponentNameFromFiber(returnFiber) || 'Component';

    if (ownerHasSymbolTypeWarning[parentName]) {
      return;
    }
    ownerHasSymbolTypeWarning[parentName] = true;

    // eslint-disable-next-line react-internal/safe-string-coercion
    const name = String(invalidChild);

    if (returnFiber.tag === HostRoot) {
      console.error(
        'Symbols are not valid as a React child.\n' + '  root.render(%s)',
        name,
      );
    } else {
      console.error(
        'Symbols are not valid as a React child.\n' + '  <%s>%s</%s>',
        parentName,
        name,
        parentName,
      );
    }
  }
}

function resolveLazy(lazyType: any) {
  const payload = lazyType._payload;
  const init = lazyType._init;
  return init(payload);
}

type ChildReconciler = (
  returnFiber: Fiber,
  currentFirstChild: Fiber | null,
  newChild: any,
  lanes: Lanes,
) => Fiber | null;

// This wrapper function exists because I expect to clone the code in each path
// to be able to optimize each path individually by branching early. This needs
// a compiler or we can do it manually. Helpers that don't need this branching
// live outside of this function.
function createChildReconciler(
  shouldTrackSideEffects: boolean,
): ChildReconciler {
  function deleteChild(returnFiber: Fiber, childToDelete: Fiber): void {
    if (!shouldTrackSideEffects) {
      // Noop.
      return;
    }
    const deletions = returnFiber.deletions;
    if (deletions === null) {
      returnFiber.deletions = [childToDelete];
      returnFiber.flags |= ChildDeletion;
    } else {
      deletions.push(childToDelete);
    }
  }

  function deleteRemainingChildren(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
  ): null {
    if (!shouldTrackSideEffects) {
      // Noop.
      return null;
    }

    // TODO: For the shouldClone case, this could be micro-optimized a bit by
    // assuming that after the first child we've already added everything.
    let childToDelete = currentFirstChild;
    while (childToDelete !== null) {
      deleteChild(returnFiber, childToDelete);
      childToDelete = childToDelete.sibling;
    }
    return null;
  }

  // 建立一个key/index fiber的映射关系 方便后面进行比较
  function mapRemainingChildren(
    currentFirstChild: Fiber,
  ): Map<string | number, Fiber> {
    // Add the remaining children to a temporary map so that we can find them by
    // keys quickly. Implicit (null) keys get added to this set with their index
    // instead.
    // 创建map保存映射关系
    const existingChildren: Map<string | number, Fiber> = new Map();

    let existingChild: null | Fiber = currentFirstChild;
    while (existingChild !== null) {
      if (existingChild.key !== null) {
        existingChildren.set(existingChild.key, existingChild);
      } else {
        existingChildren.set(existingChild.index, existingChild);
      }
      existingChild = existingChild.sibling;
    }
    // 返回结果
    return existingChildren;
  }

  function useFiber(fiber: Fiber, pendingProps: mixed): Fiber {
    // We currently set sibling to null and index to 0 here because it is easy
    // to forget to do before returning it. E.g. for the single child case.
    // 复制一份fiber 让二者alternate互指
    const clone = createWorkInProgress(fiber, pendingProps);
    // 索引设置为0
    clone.index = 0;
    // 清空兄弟节点
    clone.sibling = null;
    return clone;
  }

  // 这里有几种情况
  // 1.老节点不为空，老节点Index小于lastPlacedIndex，新的fiber位置往后面挪动了，复用老节点还需要移动，并且打上tag
  // 2.老节点不为空, 老节点index大于或等于lastPlacedIndex，说明老节点相当于新结点的位置还要靠后
  // 不需要额外的移动操作，更新lastPlacedIndex为老的fiber的index
  // 3.老节点为空,直接返回0，标记为插入
  function placeChild(
    newFiber: Fiber,
    lastPlacedIndex: number,
    newIndex: number,
  ): number {
    newFiber.index = newIndex;
    // 不需要更新副作用的情况下
    // 现在还搞不清楚怎么回事
    if (!shouldTrackSideEffects) {
      // During hydration, the useId algorithm needs to know which fibers are
      // part of a list of children (arrays, iterators).
      newFiber.flags |= Forked;
      return lastPlacedIndex;
    }
    // 移动 插入等情况下的flags处理
    // 之前tag不同的情况下current是null值
    const current = newFiber.alternate;
    if (current !== null) {
      const oldIndex = current.index;
      // 这边
      if (oldIndex < lastPlacedIndex) {
        // This is a move.
        newFiber.flags |= Placement | PlacementDEV;
        return lastPlacedIndex;
      } else {
        // This item can stay in place.
        return oldIndex;
      }
    } else {
      // This is an insertion.
      newFiber.flags |= Placement | PlacementDEV;
      return lastPlacedIndex;
    }
  }

  function placeSingleChild(newFiber: Fiber): Fiber {
    // This is simpler for the single child case. We only need to do a
    // placement for inserting new children.
    if (shouldTrackSideEffects && newFiber.alternate === null) {
      newFiber.flags |= Placement | PlacementDEV;
    }
    return newFiber;
  }

  function updateTextNode(
    returnFiber: Fiber,
    current: Fiber | null,
    textContent: string,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ) {
    if (current === null || current.tag !== HostText) {
      // Insert
      const created = createFiberFromText(textContent, returnFiber.mode, lanes);
      created.return = returnFiber;
      if (__DEV__) {
        created._debugInfo = debugInfo;
      }
      return created;
    } else {
      // Update
      const existing = useFiber(current, textContent);
      existing.return = returnFiber;
      if (__DEV__) {
        existing._debugInfo = debugInfo;
      }
      return existing;
    }
  }

  // 通用方法创建或者新增element类型fiber
  function updateElement(
    returnFiber: Fiber,
    current: Fiber | null,
    element: ReactElement,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber {
    const elementType = element.type;
    // 处理Fragment的情况
    if (elementType === REACT_FRAGMENT_TYPE) {
      return updateFragment(
        returnFiber,
        current,
        element.props.children,
        lanes,
        element.key,
        debugInfo,
      );
    }
    // 老节点存在的情况处理
    if (current !== null) {
      // 节点类型相同情况下复用
      if (
        current.elementType === elementType ||
        // Keep this check inline so it only runs on the false path:
        (__DEV__
          ? isCompatibleFamilyForHotReloading(current, element)
          : false) ||
        // Lazy types should reconcile their resolved type.
        // We need to do this after the Hot Reloading check above,
        // because hot reloading has different semantics than prod because
        // it doesn't resuspend. So we can't let the call below suspend.
        (typeof elementType === 'object' &&
          elementType !== null &&
          elementType.$$typeof === REACT_LAZY_TYPE &&
          resolveLazy(elementType) === current.type)
      ) {
        // Move based on index
        // 复用fiber
        const existing = useFiber(current, element.props);
        coerceRef(returnFiber, current, existing, element);
        existing.return = returnFiber;
        if (__DEV__) {
          existing._debugOwner = element._owner;
          existing._debugInfo = debugInfo;
        }
        return existing;
      }
    }
    // Insert
    // 老节点为空或者不满足复用条件（如新老节点类型不同）则新建并返回
    const created = createFiberFromElement(element, returnFiber.mode, lanes);
    coerceRef(returnFiber, current, created, element);
    created.return = returnFiber;
    if (__DEV__) {
      created._debugInfo = debugInfo;
    }
    return created;
  }

  function updatePortal(
    returnFiber: Fiber,
    current: Fiber | null,
    portal: ReactPortal,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber {
    if (
      current === null ||
      current.tag !== HostPortal ||
      current.stateNode.containerInfo !== portal.containerInfo ||
      current.stateNode.implementation !== portal.implementation
    ) {
      // Insert
      const created = createFiberFromPortal(portal, returnFiber.mode, lanes);
      created.return = returnFiber;
      if (__DEV__) {
        created._debugInfo = debugInfo;
      }
      return created;
    } else {
      // Update
      const existing = useFiber(current, portal.children || []);
      existing.return = returnFiber;
      if (__DEV__) {
        existing._debugInfo = debugInfo;
      }
      return existing;
    }
  }

  function updateFragment(
    returnFiber: Fiber,
    current: Fiber | null,
    fragment: Iterable<React$Node>,
    lanes: Lanes,
    key: null | string,
    debugInfo: null | ReactDebugInfo,
  ): Fiber {
    if (current === null || current.tag !== Fragment) {
      // Insert
      const created = createFiberFromFragment(
        fragment,
        returnFiber.mode,
        lanes,
        key,
      );
      created.return = returnFiber;
      if (__DEV__) {
        created._debugInfo = debugInfo;
      }
      return created;
    } else {
      // Update
      const existing = useFiber(current, fragment);
      existing.return = returnFiber;
      if (__DEV__) {
        existing._debugInfo = debugInfo;
      }
      return existing;
    }
  }

  function createChild(
    returnFiber: Fiber,
    newChild: any,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber | null {
    if (
      (typeof newChild === 'string' && newChild !== '') ||
      typeof newChild === 'number' ||
      typeof newChild === 'bigint'
    ) {
      // Text nodes don't have keys. If the previous node is implicitly keyed
      // we can continue to replace it without aborting even if it is not a text
      // node.
      const created = createFiberFromText(
        // $FlowFixMe[unsafe-addition] Flow doesn't want us to use `+` operator with string and bigint
        '' + newChild,
        returnFiber.mode,
        lanes,
      );
      created.return = returnFiber;
      if (__DEV__) {
        created._debugInfo = debugInfo;
      }
      return created;
    }

    if (typeof newChild === 'object' && newChild !== null) {
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          const created = createFiberFromElement(
            newChild,
            returnFiber.mode,
            lanes,
          );
          coerceRef(returnFiber, null, created, newChild);
          created.return = returnFiber;
          if (__DEV__) {
            created._debugInfo = mergeDebugInfo(debugInfo, newChild._debugInfo);
          }
          return created;
        }
        case REACT_PORTAL_TYPE: {
          const created = createFiberFromPortal(
            newChild,
            returnFiber.mode,
            lanes,
          );
          created.return = returnFiber;
          if (__DEV__) {
            created._debugInfo = debugInfo;
          }
          return created;
        }
        case REACT_LAZY_TYPE: {
          const payload = newChild._payload;
          const init = newChild._init;
          return createChild(
            returnFiber,
            init(payload),
            lanes,
            mergeDebugInfo(debugInfo, newChild._debugInfo), // call merge after init
          );
        }
      }

      if (
        isArray(newChild) ||
        getIteratorFn(newChild) ||
        (enableAsyncIterableChildren &&
          typeof newChild[ASYNC_ITERATOR] === 'function')
      ) {
        const created = createFiberFromFragment(
          newChild,
          returnFiber.mode,
          lanes,
          null,
        );
        created.return = returnFiber;
        if (__DEV__) {
          created._debugInfo = mergeDebugInfo(debugInfo, newChild._debugInfo);
        }
        return created;
      }

      // Usable node types
      //
      // Unwrap the inner value and recursively call this function again.
      if (typeof newChild.then === 'function') {
        const thenable: Thenable<any> = (newChild: any);
        return createChild(
          returnFiber,
          unwrapThenable(thenable),
          lanes,
          mergeDebugInfo(debugInfo, newChild._debugInfo),
        );
      }

      if (newChild.$$typeof === REACT_CONTEXT_TYPE) {
        const context: ReactContext<mixed> = (newChild: any);
        return createChild(
          returnFiber,
          readContextDuringReconciliation(returnFiber, context, lanes),
          lanes,
          debugInfo,
        );
      }

      throwOnInvalidObjectType(returnFiber, newChild);
    }

    if (__DEV__) {
      if (typeof newChild === 'function') {
        warnOnFunctionType(returnFiber, newChild);
      }
      if (typeof newChild === 'symbol') {
        warnOnSymbolType(returnFiber, newChild);
      }
    }

    return null;
  }

  function updateSlot(
    returnFiber: Fiber,
    oldFiber: Fiber | null,
    newChild: any,
    lanes: Lanes,
    debugInfo: null | ReactDebugInfo,
  ): Fiber | null {
    // Update the fiber if the keys match, otherwise return null.
    const key = oldFiber !== null ? oldFiber.key : null;

    if (
      (typeof newChild === 'string' && newChild !== '') ||
      typeof newChild === 'number' ||
      typeof newChild === 'bigint'
    ) {
      // Text nodes don't have keys. If the previous node is implicitly keyed
      // we can continue to replace it without aborting even if it is not a text
      // node.
      
      if (key !== null) {
        return null;
      }
      return updateTextNode(
        returnFiber,
        oldFiber,
        // $FlowFixMe[unsafe-addition] Flow doesn't want us to use `+` operator with string and bigint
        '' + newChild,
        lanes,
        debugInfo,
      );
    }

    // key相等满足复用条件则更新
    // 根据不同type更新元素
    if (typeof newChild === 'object' && newChild !== null) {
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          if (newChild.key === key) {
            return updateElement(
              returnFiber,
              oldFiber,
              newChild,
              lanes,
              mergeDebugInfo(debugInfo, newChild._debugInfo),
            );
          } else {
            return null;
          }
        }
        case REACT_PORTAL_TYPE: {
          if (newChild.key === key) {
            return updatePortal(
              returnFiber,
              oldFiber,
              newChild,
              lanes,
              debugInfo,
            );
          } else {
            return null;
          }
        }
        case REACT_LAZY_TYPE: {
          const payload = newChild._payload;
          const init = newChild._init;
          return updateSlot(
            returnFiber,
            oldFiber,
            init(payload),
            lanes,
            mergeDebugInfo(debugInfo, newChild._debugInfo),
          );
        }
      }

      if (
        isArray(newChild) ||
        getIteratorFn(newChild) ||
        (enableAsyncIterableChildren &&
          typeof newChild[ASYNC_ITERATOR] === 'function')
      ) {
        if (key !== null) {
          return null;
        }

        return updateFragment(
          returnFiber,
          oldFiber,
          newChild,
          lanes,
          null,
          mergeDebugInfo(debugInfo, newChild._debugInfo),
        );
      }

      // Usable node types
      //
      // Unwrap the inner value and recursively call this function again.
      if (typeof newChild.then === 'function') {
        const thenable: Thenable<any> = (newChild: any);
        return updateSlot(
          returnFiber,
          oldFiber,
          unwrapThenable(thenable),
          lanes,
          debugInfo,
        );
      }

      if (newChild.$$typeof === REACT_CONTEXT_TYPE) {
        const context: ReactContext<mixed> = (newChild: any);
        return updateSlot(
          returnFiber,
          oldFiber,
          readContextDuringReconciliation(returnFiber, context, lanes),
          lanes,
          debugInfo,
        );
      }

      throwOnInvalidObjectType(returnFiber, newChild);
    }

    if (__DEV__) {
      if (typeof newChild === 'function') {
        warnOnFunctionType(returnFiber, newChild);
      }
      if (typeof newChild === 'symbol') {
        warnOnSymbolType(returnFiber, newChild);
      }
    }

    return null;
  }

  function updateFromMap(
    existingChildren: Map<string | number, Fiber>,
    returnFiber: Fiber,
    newIdx: number,
    newChild: any,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber | null {
    // text和number节点更新成本低廉 直接更新
    if (
      (typeof newChild === 'string' && newChild !== '') ||
      typeof newChild === 'number' ||
      typeof newChild === 'bigint'
    ) {
      // Text nodes don't have keys, so we neither have to check the old nor
      // new node for the key. If both are text nodes, they match.
      const matchedFiber = existingChildren.get(newIdx) || null;
      return updateTextNode(
        returnFiber,
        matchedFiber,
        // $FlowFixMe[unsafe-addition] Flow doesn't want us to use `+` operator with string and bigint
        '' + newChild,
        lanes,
        debugInfo,
      );
    }

    // 尽力去找有没有key和类型都一样的节点 有的话就复用
    if (typeof newChild === 'object' && newChild !== null) {
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          const matchedFiber =
            existingChildren.get(
              newChild.key === null ? newIdx : newChild.key,
            ) || null;
          return updateElement(
            returnFiber,
            matchedFiber,
            newChild,
            lanes,
            mergeDebugInfo(debugInfo, newChild._debugInfo),
          );
        }
        case REACT_PORTAL_TYPE: {
          const matchedFiber =
            existingChildren.get(
              newChild.key === null ? newIdx : newChild.key,
            ) || null;
          return updatePortal(
            returnFiber,
            matchedFiber,
            newChild,
            lanes,
            debugInfo,
          );
        }
        case REACT_LAZY_TYPE:
          const payload = newChild._payload;
          const init = newChild._init;
          return updateFromMap(
            existingChildren,
            returnFiber,
            newIdx,
            init(payload),
            lanes,
            mergeDebugInfo(debugInfo, newChild._debugInfo),
          );
      }

      if (
        isArray(newChild) ||
        getIteratorFn(newChild) ||
        (enableAsyncIterableChildren &&
          typeof newChild[ASYNC_ITERATOR] === 'function')
      ) {
        const matchedFiber = existingChildren.get(newIdx) || null;
        return updateFragment(
          returnFiber,
          matchedFiber,
          newChild,
          lanes,
          null,
          mergeDebugInfo(debugInfo, newChild._debugInfo),
        );
      }

      // Usable node types
      //
      // Unwrap the inner value and recursively call this function again.
      if (typeof newChild.then === 'function') {
        const thenable: Thenable<any> = (newChild: any);
        return updateFromMap(
          existingChildren,
          returnFiber,
          newIdx,
          unwrapThenable(thenable),
          lanes,
          debugInfo,
        );
      }

      if (newChild.$$typeof === REACT_CONTEXT_TYPE) {
        const context: ReactContext<mixed> = (newChild: any);
        return updateFromMap(
          existingChildren,
          returnFiber,
          newIdx,
          readContextDuringReconciliation(returnFiber, context, lanes),
          lanes,
          debugInfo,
        );
      }

      throwOnInvalidObjectType(returnFiber, newChild);
    }

    if (__DEV__) {
      if (typeof newChild === 'function') {
        warnOnFunctionType(returnFiber, newChild);
      }
      if (typeof newChild === 'symbol') {
        warnOnSymbolType(returnFiber, newChild);
      }
    }

    return null;
  }

  /**
   * Warns if there is a duplicate or missing key
   */
  function warnOnInvalidKey(
    child: mixed,
    knownKeys: Set<string> | null,
    returnFiber: Fiber,
  ): Set<string> | null {
    if (__DEV__) {
      if (typeof child !== 'object' || child === null) {
        return knownKeys;
      }
      switch (child.$$typeof) {
        case REACT_ELEMENT_TYPE:
        case REACT_PORTAL_TYPE:
          warnForMissingKey(child, returnFiber);
          const key = child.key;
          if (typeof key !== 'string') {
            break;
          }
          if (knownKeys === null) {
            knownKeys = new Set();
            knownKeys.add(key);
            break;
          }
          if (!knownKeys.has(key)) {
            knownKeys.add(key);
            break;
          }
          console.error(
            'Encountered two children with the same key, `%s`. ' +
              'Keys should be unique so that components maintain their identity ' +
              'across updates. Non-unique keys may cause children to be ' +
              'duplicated and/or omitted — the behavior is unsupported and ' +
              'could change in a future version.',
            key,
          );
          break;
        case REACT_LAZY_TYPE:
          const payload = child._payload;
          const init = (child._init: any);
          warnOnInvalidKey(init(payload), knownKeys, returnFiber);
          break;
        default:
          break;
      }
    }
    return knownKeys;
  }

  // 首先会有两轮循环 第一轮是比较能够复用的节点直到Key不同跳出本次循环
  // 第二次是比较移动的节点
  function reconcileChildrenArray(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChildren: Array<any>,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber | null {
    // This algorithm can't optimize by searching from both ends since we
    // don't have backpointers on fibers. I'm trying to see how far we can get
    // with that model. If it ends up not being worth the tradeoffs, we can
    // add it later.

    // Even with a two ended optimization, we'd want to optimize for the case
    // where there are few changes and brute force the comparison instead of
    // going for the Map. It'd like to explore hitting that path first in
    // forward-only mode and only go for the Map once we notice that we need
    // lots of look ahead. This doesn't handle reversal as well as two ended
    // search but that's unusual. Besides, for the two ended optimization to
    // work on Iterables, we'd need to copy the whole set.

    // In this first iteration, we'll just live with hitting the bad case
    // (adding everything to a Map) in for every insert/move.

    // If you change this code, also update reconcileChildrenIterator() which
    // uses the same algorithm.

    if (__DEV__) {
      // First, validate keys.
      let knownKeys: Set<string> | null = null;
      for (let i = 0; i < newChildren.length; i++) {
        const child = newChildren[i];
        knownKeys = warnOnInvalidKey(child, knownKeys, returnFiber);
      }
    }

    let resultingFirstChild: Fiber | null = null; // 需要返回的第一个新fiber
    let previousNewFiber: Fiber | null = null; // 上一个新fiber

    let oldFiber = currentFirstChild; // 取出第一个老fiber
    let lastPlacedIndex = 0;
    let newIdx = 0; // 新VDOM节点索引
    let nextOldFiber = null; // 指向下一个老的fiber
    // 新老fiber都存在的情况 第一次循环 尽最大努力复用老节点
    for (; oldFiber !== null && newIdx < newChildren.length; newIdx++) {
      // 一个指针，每对比完成一个fiber就指向下一个老的fiber
      // 新的fiber对比完成了 说明当前已经比较完成 将老的fiber链置为空
      if (oldFiber.index > newIdx) {
        nextOldFiber = oldFiber;
        oldFiber = null;
      } else {
        // 没有比较完成的情况下还需要向后面移动指针进行下一轮比较
        nextOldFiber = oldFiber.sibling;
      }
      // 试图复用老的fiber,此时不能复用有两种情况，一是key不一样直接不能复用，这个时候会直接返回null，
      // 二是key一样 但是节点类型改变了 此时会新建节点fiber 所以newFiber为空的情况下，肯定是
      // key不同的情况 这个时候直接跳出循环 不再进行比较
      const newFiber = updateSlot(
        returnFiber,
        oldFiber,
        newChildren[newIdx],
        lanes,
        debugInfo,
      );
      if (newFiber === null) {
        // TODO: This breaks on empty slots like null children. That's
        // unfortunate because it triggers the slow path all the time. We need
        // a better way to communicate whether this was a miss or null,
        // boolean, undefined, etc.
        if (oldFiber === null) {
          oldFiber = nextOldFiber;
        }
        // 老fiber因为上述原因导致无法复用 就跳出本次循环
        break;
      }
      if (shouldTrackSideEffects) {
        // 这种情况应该是新老fiber tag不一样 所以前面的updateSlot创建了新的fiber并返回了
        // 老fiber存在 新fiber并不复用老fiber 删掉当前fiber
        if (oldFiber && newFiber.alternate === null) {
          // We matched the slot, but we didn't reuse the existing fiber, so we
          // need to delete the existing child.
          // 不能复用 直接毙掉
          deleteChild(returnFiber, oldFiber);
        }
      }
      // 根据情况添加一些副作用flag 同时设置个index用来作为是否需要移动元素的参照物
      lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
      // 构建resultingFirstChild并且让previousNewFiber不断指向下一个Fiber
      if (previousNewFiber === null) {
        // TODO: Move out of the loop. This only happens for the first run.
        resultingFirstChild = newFiber;
      } else {
        // TODO: Defer siblings if we're not at the right index for this slot.
        // I.e. if we had null values before, then we want to defer this
        // for each null value. However, we also don't want to call updateSlot
        // with the previous one.
        previousNewFiber.sibling = newFiber;
      }
      previousNewFiber = newFiber;
      // oldFiber指向下一个fiber 实现循环交替不断读取下一个fiber
      oldFiber = nextOldFiber;
    }

    // 如果新节点全部完成遍历 删除老节点剩余部分 不再进行下一步操作
    if (newIdx === newChildren.length) {
      // We've reached the end of the new children. We can delete the rest.
      deleteRemainingChildren(returnFiber, oldFiber);
      if (getIsHydrating()) {
        const numberOfForks = newIdx;
        pushTreeFork(returnFiber, numberOfForks);
      }
      return resultingFirstChild;
    }

    // 如果老fiber不存在
    if (oldFiber === null) {
      // If we don't have any more existing children we can choose a fast path
      // since the rest will all be insertions.
      // loop每个VDOM节点 为其创建新的fiber
      // 通过循环创建fiber链
      for (; newIdx < newChildren.length; newIdx++) {
        const newFiber = createChild(
          returnFiber,
          newChildren[newIdx],
          lanes,
          debugInfo,
        );
        if (newFiber === null) {
          continue;
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        // 这里根据注释判断，应该是初次渲染的情况下 之前的新fiber还不存在
        // 这里只会进来一次 后面都不会进来
        if (previousNewFiber === null) {
          // TODO: Move out of the loop. This only happens for the first run.
          resultingFirstChild = newFiber;
        } else {
          // 存在则挂载到之前新fiber上面的兄弟节点
          previousNewFiber.sibling = newFiber;
        }
        // 和上面的previousNewFiber.sibling的指向一起循环往下个fiber节点走
        // 比如 a -> b -> c
        previousNewFiber = newFiber;
      }
      if (getIsHydrating()) {
        const numberOfForks = newIdx;
        pushTreeFork(returnFiber, numberOfForks);
      }
      return resultingFirstChild;
    }

    // Add all children to a key map for quick lookups.
    const existingChildren = mapRemainingChildren(oldFiber);

    // Keep scanning and use the map to restore deleted items as moves.
    for (; newIdx < newChildren.length; newIdx++) {
      const newFiber = updateFromMap(
        existingChildren,
        returnFiber,
        newIdx,
        newChildren[newIdx],
        lanes,
        debugInfo,
      );
      // 找到的情况下
      if (newFiber !== null) {
        if (shouldTrackSideEffects) {
          if (newFiber.alternate !== null) {
            // The new fiber is a work in progress, but if there exists a
            // current, that means that we reused the fiber. We need to delete
            // it from the child list so that we don't add it to the deletion
            // list.
            // 删除老的fiber树 优化策略
            existingChildren.delete(
              newFiber.key === null ? newIdx : newFiber.key,
            );
          }
        }
        // 是否需要移动判断逻辑
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        // 通过指针往后遍历fiber
        if (previousNewFiber === null) {
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
    }

    if (shouldTrackSideEffects) {
      // Any existing children that weren't consumed above were deleted. We need
      // to add them to the deletion list.
      // 没用到的老fiber需要删除
      existingChildren.forEach(child => deleteChild(returnFiber, child));
    }

    if (getIsHydrating()) {
      const numberOfForks = newIdx;
      pushTreeFork(returnFiber, numberOfForks);
    }
    return resultingFirstChild;
  }

  function reconcileChildrenIteratable(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChildrenIterable: Iterable<mixed>,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber | null {
    // This is the same implementation as reconcileChildrenArray(),
    // but using the iterator instead.

    const iteratorFn = getIteratorFn(newChildrenIterable);

    if (typeof iteratorFn !== 'function') {
      throw new Error(
        'An object is not an iterable. This error is likely caused by a bug in ' +
          'React. Please file an issue.',
      );
    }

    const newChildren = iteratorFn.call(newChildrenIterable);

    if (__DEV__) {
      if (newChildren === newChildrenIterable) {
        // We don't support rendering Generators as props because it's a mutation.
        // See https://github.com/facebook/react/issues/12995
        // We do support generators if they were created by a GeneratorFunction component
        // as its direct child since we can recreate those by rerendering the component
        // as needed.
        const isGeneratorComponent =
          returnFiber.tag === FunctionComponent &&
          // $FlowFixMe[method-unbinding]
          Object.prototype.toString.call(returnFiber.type) ===
            '[object GeneratorFunction]' &&
          // $FlowFixMe[method-unbinding]
          Object.prototype.toString.call(newChildren) === '[object Generator]';
        if (!isGeneratorComponent) {
          if (!didWarnAboutGenerators) {
            console.error(
              'Using Iterators as children is unsupported and will likely yield ' +
                'unexpected results because enumerating a generator mutates it. ' +
                'You may convert it to an array with `Array.from()` or the ' +
                '`[...spread]` operator before rendering. You can also use an ' +
                'Iterable that can iterate multiple times over the same items.',
            );
          }
          didWarnAboutGenerators = true;
        }
      } else if ((newChildrenIterable: any).entries === iteratorFn) {
        // Warn about using Maps as children
        if (!didWarnAboutMaps) {
          console.error(
            'Using Maps as children is not supported. ' +
              'Use an array of keyed ReactElements instead.',
          );
          didWarnAboutMaps = true;
        }
      }
    }

    return reconcileChildrenIterator(
      returnFiber,
      currentFirstChild,
      newChildren,
      lanes,
      debugInfo,
    );
  }

  function reconcileChildrenAsyncIteratable(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChildrenIterable: AsyncIterable<mixed>,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber | null {
    const newChildren = newChildrenIterable[ASYNC_ITERATOR]();

    if (__DEV__) {
      if (newChildren === newChildrenIterable) {
        // We don't support rendering AsyncGenerators as props because it's a mutation.
        // We do support generators if they were created by a AsyncGeneratorFunction component
        // as its direct child since we can recreate those by rerendering the component
        // as needed.
        const isGeneratorComponent =
          returnFiber.tag === FunctionComponent &&
          // $FlowFixMe[method-unbinding]
          Object.prototype.toString.call(returnFiber.type) ===
            '[object AsyncGeneratorFunction]' &&
          // $FlowFixMe[method-unbinding]
          Object.prototype.toString.call(newChildren) ===
            '[object AsyncGenerator]';
        if (!isGeneratorComponent) {
          if (!didWarnAboutGenerators) {
            console.error(
              'Using AsyncIterators as children is unsupported and will likely yield ' +
                'unexpected results because enumerating a generator mutates it. ' +
                'You can use an AsyncIterable that can iterate multiple times over ' +
                'the same items.',
            );
          }
          didWarnAboutGenerators = true;
        }
      }
    }

    if (newChildren == null) {
      throw new Error('An iterable object provided no iterator.');
    }

    // To save bytes, we reuse the logic by creating a synchronous Iterable and
    // reusing that code path.
    const iterator: Iterator<mixed> = ({
      next(): IteratorResult<mixed, void> {
        return unwrapThenable(newChildren.next());
      },
    }: any);

    return reconcileChildrenIterator(
      returnFiber,
      currentFirstChild,
      iterator,
      lanes,
      debugInfo,
    );
  }

  function reconcileChildrenIterator(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChildren: ?Iterator<mixed>,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber | null {
    if (newChildren == null) {
      throw new Error('An iterable object provided no iterator.');
    }

    let resultingFirstChild: Fiber | null = null;
    let previousNewFiber: Fiber | null = null;

    let oldFiber = currentFirstChild;
    let lastPlacedIndex = 0;
    let newIdx = 0;
    let nextOldFiber = null;

    let knownKeys: Set<string> | null = null;

    let step = newChildren.next();
    if (__DEV__) {
      knownKeys = warnOnInvalidKey(step.value, knownKeys, returnFiber);
    }
    for (
      ;
      oldFiber !== null && !step.done;
      newIdx++,
        step = newChildren.next(),
        knownKeys = __DEV__
          ? warnOnInvalidKey(step.value, knownKeys, returnFiber)
          : null
    ) {
      if (oldFiber.index > newIdx) {
        nextOldFiber = oldFiber;
        oldFiber = null;
      } else {
        nextOldFiber = oldFiber.sibling;
      }
      const newFiber = updateSlot(
        returnFiber,
        oldFiber,
        step.value,
        lanes,
        debugInfo,
      );
      if (newFiber === null) {
        // TODO: This breaks on empty slots like null children. That's
        // unfortunate because it triggers the slow path all the time. We need
        // a better way to communicate whether this was a miss or null,
        // boolean, undefined, etc.
        if (oldFiber === null) {
          oldFiber = nextOldFiber;
        }
        break;
      }
      if (shouldTrackSideEffects) {
        if (oldFiber && newFiber.alternate === null) {
          // We matched the slot, but we didn't reuse the existing fiber, so we
          // need to delete the existing child.
          deleteChild(returnFiber, oldFiber);
        }
      }
      lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
      if (previousNewFiber === null) {
        // TODO: Move out of the loop. This only happens for the first run.
        resultingFirstChild = newFiber;
      } else {
        // TODO: Defer siblings if we're not at the right index for this slot.
        // I.e. if we had null values before, then we want to defer this
        // for each null value. However, we also don't want to call updateSlot
        // with the previous one.
        previousNewFiber.sibling = newFiber;
      }
      previousNewFiber = newFiber;
      oldFiber = nextOldFiber;
    }

    if (step.done) {
      // We've reached the end of the new children. We can delete the rest.
      deleteRemainingChildren(returnFiber, oldFiber);
      if (getIsHydrating()) {
        const numberOfForks = newIdx;
        pushTreeFork(returnFiber, numberOfForks);
      }
      return resultingFirstChild;
    }

    if (oldFiber === null) {
      // If we don't have any more existing children we can choose a fast path
      // since the rest will all be insertions.
      for (
        ;
        !step.done;
        newIdx++,
          step = newChildren.next(),
          knownKeys = __DEV__
            ? warnOnInvalidKey(step.value, knownKeys, returnFiber)
            : null
      ) {
        const newFiber = createChild(returnFiber, step.value, lanes, debugInfo);
        if (newFiber === null) {
          continue;
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        if (previousNewFiber === null) {
          // TODO: Move out of the loop. This only happens for the first run.
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
      if (getIsHydrating()) {
        const numberOfForks = newIdx;
        pushTreeFork(returnFiber, numberOfForks);
      }
      return resultingFirstChild;
    }

    // Add all children to a key map for quick lookups.
    const existingChildren = mapRemainingChildren(oldFiber);

    // Keep scanning and use the map to restore deleted items as moves.
    for (
      ;
      !step.done;
      newIdx++,
        step = newChildren.next(),
        knownKeys = __DEV__
          ? warnOnInvalidKey(step.value, knownKeys, returnFiber)
          : null
    ) {
      const newFiber = updateFromMap(
        existingChildren,
        returnFiber,
        newIdx,
        step.value,
        lanes,
        debugInfo,
      );
      if (newFiber !== null) {
        if (shouldTrackSideEffects) {
          if (newFiber.alternate !== null) {
            // The new fiber is a work in progress, but if there exists a
            // current, that means that we reused the fiber. We need to delete
            // it from the child list so that we don't add it to the deletion
            // list.
            existingChildren.delete(
              newFiber.key === null ? newIdx : newFiber.key,
            );
          }
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        if (previousNewFiber === null) {
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
    }

    if (shouldTrackSideEffects) {
      // Any existing children that weren't consumed above were deleted. We need
      // to add them to the deletion list.
      existingChildren.forEach(child => deleteChild(returnFiber, child));
    }

    if (getIsHydrating()) {
      const numberOfForks = newIdx;
      pushTreeFork(returnFiber, numberOfForks);
    }
    return resultingFirstChild;
  }

  function reconcileSingleTextNode(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    textContent: string,
    lanes: Lanes,
  ): Fiber {
    // There's no need to check for keys on text nodes since we don't have a
    // way to define them.
    if (currentFirstChild !== null && currentFirstChild.tag === HostText) {
      // We already have an existing node so let's just update it and delete
      // the rest.
      // 能匹配 删除兄弟节点
      deleteRemainingChildren(returnFiber, currentFirstChild.sibling);
      const existing = useFiber(currentFirstChild, textContent);
      existing.return = returnFiber;
      return existing;
    }
    // The existing first child is not a text node so we need to create one
    // and delete the existing ones.
    // 不能匹配 删除自身 新建节点
    deleteRemainingChildren(returnFiber, currentFirstChild);
    const created = createFiberFromText(textContent, returnFiber.mode, lanes);
    created.return = returnFiber;
    return created;
  }

  function reconcileSingleElement(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    element: ReactElement,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber {
    const key = element.key;
    let child = currentFirstChild;
    while (child !== null) {
      // TODO: If key === null and child.key === null, then this only applies to
      // the first item in the list.
      // 判断key是否相同 相同则进入后续判断
      if (child.key === key) {
        const elementType = element.type;
        if (elementType === REACT_FRAGMENT_TYPE) {
          if (child.tag === Fragment) {
            // key和type相同 先清空兄弟节点 以便本次能够复用
            deleteRemainingChildren(returnFiber, child.sibling);
            // 此处克隆的child 兄弟节点是空的
            // 所以上面的删除逻辑应该是为了和这里克隆操作一致
            const existing = useFiber(child, element.props.children);
            existing.return = returnFiber;
            if (__DEV__) {
              existing._debugOwner = element._owner;
              existing._debugInfo = debugInfo;
            }
            return existing;
          }
        } else {
          if (
            child.elementType === elementType ||
            // Keep this check inline so it only runs on the false path:
            (__DEV__
              ? isCompatibleFamilyForHotReloading(child, element)
              : false) ||
            // Lazy types should reconcile their resolved type.
            // We need to do this after the Hot Reloading check above,
            // because hot reloading has different semantics than prod because
            // it doesn't resuspend. So we can't let the call below suspend.
            (typeof elementType === 'object' &&
              elementType !== null &&
              elementType.$$typeof === REACT_LAZY_TYPE &&
              resolveLazy(elementType) === child.type)
          ) {
            // 和上面逻辑类似 相同清空兄弟节点 以便复用
            deleteRemainingChildren(returnFiber, child.sibling);
            const existing = useFiber(child, element.props);
            coerceRef(returnFiber, child, existing, element);
            existing.return = returnFiber;
            if (__DEV__) {
              existing._debugOwner = element._owner;
              existing._debugInfo = debugInfo;
            }
            return existing;
          }
        }
        // key相同type不同 
        // Didn't match.
        // 删除包含当前fiber的所有fiber
        deleteRemainingChildren(returnFiber, child);
        break;
      } else {
        // 删除当前fiber
        deleteChild(returnFiber, child);
      }
      // 这个时候child指向兄弟节点 看看能不能复用
      child = child.sibling;
    }

    // 未能进行复用的就走新建逻辑
    if (element.type === REACT_FRAGMENT_TYPE) {
      const created = createFiberFromFragment(
        element.props.children,
        returnFiber.mode,
        lanes,
        element.key,
      );
      created.return = returnFiber;
      if (__DEV__) {
        created._debugInfo = debugInfo;
      }
      return created;
    } else {
      const created = createFiberFromElement(element, returnFiber.mode, lanes);
      coerceRef(returnFiber, currentFirstChild, created, element);
      created.return = returnFiber;
      if (__DEV__) {
        created._debugInfo = debugInfo;
      }
      return created;
    }
  }

  function reconcileSinglePortal(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    portal: ReactPortal,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber {
    const key = portal.key;
    let child = currentFirstChild;
    while (child !== null) {
      // TODO: If key === null and child.key === null, then this only applies to
      // the first item in the list.
      if (child.key === key) {
        if (
          child.tag === HostPortal &&
          child.stateNode.containerInfo === portal.containerInfo &&
          child.stateNode.implementation === portal.implementation
        ) {
          deleteRemainingChildren(returnFiber, child.sibling);
          const existing = useFiber(child, portal.children || []);
          existing.return = returnFiber;
          return existing;
        } else {
          deleteRemainingChildren(returnFiber, child);
          break;
        }
      } else {
        deleteChild(returnFiber, child);
      }
      child = child.sibling;
    }

    const created = createFiberFromPortal(portal, returnFiber.mode, lanes);
    created.return = returnFiber;
    return created;
  }

  // This API will tag the children with the side-effect of the reconciliation
  // itself. They will be added to the side-effect list as we pass through the
  // children and the parent.
  function reconcileChildFibersImpl(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChild: any,
    lanes: Lanes,
    debugInfo: ReactDebugInfo | null,
  ): Fiber | null {
    // This function is only recursive for Usables/Lazy and not nested arrays.
    // That's so that using a Lazy wrapper is unobservable to the Fragment
    // convention.
    // If the top level item is an array, we treat it as a set of children,
    // not as a fragment. Nested arrays on the other hand will be treated as
    // fragment nodes. Recursion happens at the normal flow.

    // Handle top level unkeyed fragments as if they were arrays.
    // This leads to an ambiguity between <>{[...]}</> and <>...</>.
    // We treat the ambiguous cases above the same.
    // We don't use recursion here because a fragment inside a fragment
    // is no longer considered "top level" for these purposes.
    const isUnkeyedTopLevelFragment =
      typeof newChild === 'object' &&
      newChild !== null &&
      newChild.type === REACT_FRAGMENT_TYPE &&
      newChild.key === null;
    if (isUnkeyedTopLevelFragment) {
      newChild = newChild.props.children;
    }

    // 根据不同组件类型 选择不同的diff函数进行处理
    // Handle object types
    if (typeof newChild === 'object' && newChild !== null) {
      switch (newChild.$$typeof) {
        // 常规react元素比较方法
        case REACT_ELEMENT_TYPE:
          // placeSingleChild 用来判断是否第一次渲染
          // 就是给effecttag赋值 决定后期是否需要挂载dom
          return placeSingleChild(
            reconcileSingleElement(
              returnFiber,
              currentFirstChild,
              newChild,
              lanes,
              mergeDebugInfo(debugInfo, newChild._debugInfo),
            ),
          );
        case REACT_PORTAL_TYPE:
          // just for portal
          return placeSingleChild(
            reconcileSinglePortal(
              returnFiber,
              currentFirstChild,
              newChild,
              lanes,
              debugInfo,
            ),
          );
        case REACT_LAZY_TYPE:
          const payload = newChild._payload;
          const init = newChild._init;
          return reconcileChildFibersImpl(
            returnFiber,
            currentFirstChild,
            init(payload),
            lanes,
            mergeDebugInfo(debugInfo, newChild._debugInfo),
          );
      }

      // 多节点处理
      if (isArray(newChild)) {
        return reconcileChildrenArray(
          returnFiber,
          currentFirstChild,
          newChild,
          lanes,
          mergeDebugInfo(debugInfo, newChild._debugInfo),
        );
      }

      // iterate way
      if (getIteratorFn(newChild)) {
        return reconcileChildrenIteratable(
          returnFiber,
          currentFirstChild,
          newChild,
          lanes,
          mergeDebugInfo(debugInfo, newChild._debugInfo),
        );
      }

      if (
        enableAsyncIterableChildren &&
        typeof newChild[ASYNC_ITERATOR] === 'function'
      ) {
        return reconcileChildrenAsyncIteratable(
          returnFiber,
          currentFirstChild,
          newChild,
          lanes,
          mergeDebugInfo(debugInfo, newChild._debugInfo),
        );
      }

      // Usables are a valid React node type. When React encounters a Usable in
      // a child position, it unwraps it using the same algorithm as `use`. For
      // example, for promises, React will throw an exception to unwind the
      // stack, then replay the component once the promise resolves.
      //
      // A difference from `use` is that React will keep unwrapping the value
      // until it reaches a non-Usable type.
      //
      // e.g. Usable<Usable<Usable<T>>> should resolve to T
      //
      // The structure is a bit unfortunate. Ideally, we shouldn't need to
      // replay the entire begin phase of the parent fiber in order to reconcile
      // the children again. This would require a somewhat significant refactor,
      // because reconcilation happens deep within the begin phase, and
      // depending on the type of work, not always at the end. We should
      // consider as an future improvement.
      if (typeof newChild.then === 'function') {
        const thenable: Thenable<any> = (newChild: any);
        return reconcileChildFibersImpl(
          returnFiber,
          currentFirstChild,
          unwrapThenable(thenable),
          lanes,
          mergeDebugInfo(debugInfo, thenable._debugInfo),
        );
      }

      if (newChild.$$typeof === REACT_CONTEXT_TYPE) {
        const context: ReactContext<mixed> = (newChild: any);
        return reconcileChildFibersImpl(
          returnFiber,
          currentFirstChild,
          readContextDuringReconciliation(returnFiber, context, lanes),
          lanes,
          debugInfo,
        );
      }

      throwOnInvalidObjectType(returnFiber, newChild);
    }

    if (
      (typeof newChild === 'string' && newChild !== '') ||
      typeof newChild === 'number' ||
      typeof newChild === 'bigint'
    ) {
      return placeSingleChild(
        reconcileSingleTextNode(
          returnFiber,
          currentFirstChild,
          // $FlowFixMe[unsafe-addition] Flow doesn't want us to use `+` operator with string and bigint
          '' + newChild,
          lanes,
        ),
      );
    }

    if (__DEV__) {
      if (typeof newChild === 'function') {
        warnOnFunctionType(returnFiber, newChild);
      }
      if (typeof newChild === 'symbol') {
        warnOnSymbolType(returnFiber, newChild);
      }
    }

    // 比较完毕 删除剩余节点
    // Remaining cases are all treated as empty.
    return deleteRemainingChildren(returnFiber, currentFirstChild);
  }

  function reconcileChildFibers(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChild: any,
    lanes: Lanes,
  ): Fiber | null {
    // This indirection only exists so we can reset `thenableState` at the end.
    // It should get inlined by Closure.
    thenableIndexCounter = 0;
    const firstChildFiber = reconcileChildFibersImpl(
      returnFiber,
      currentFirstChild,
      newChild,
      lanes,
      null, // debugInfo
    );
    thenableState = null;
    // Don't bother to reset `thenableIndexCounter` to 0 because it always gets
    // set at the beginning.
    return firstChildFiber;
  }

  return reconcileChildFibers;
}

export const reconcileChildFibers: ChildReconciler =
  createChildReconciler(true);
export const mountChildFibers: ChildReconciler = createChildReconciler(false);

export function resetChildReconcilerOnUnwind(): void {
  // On unwind, clear any pending thenables that were used.
  thenableState = null;
  thenableIndexCounter = 0;
}

export function cloneChildFibers(
  current: Fiber | null,
  workInProgress: Fiber,
): void {
  if (current !== null && workInProgress.child !== current.child) {
    throw new Error('Resuming work not yet implemented.');
  }

  if (workInProgress.child === null) {
    return;
  }

  let currentChild = workInProgress.child;
  let newChild = createWorkInProgress(currentChild, currentChild.pendingProps);
  workInProgress.child = newChild;

  newChild.return = workInProgress;
  while (currentChild.sibling !== null) {
    currentChild = currentChild.sibling;
    newChild = newChild.sibling = createWorkInProgress(
      currentChild,
      currentChild.pendingProps,
    );
    newChild.return = workInProgress;
  }
  newChild.sibling = null;
}

// Reset a workInProgress child set to prepare it for a second pass.
export function resetChildFibers(workInProgress: Fiber, lanes: Lanes): void {
  let child = workInProgress.child;
  while (child !== null) {
    resetWorkInProgress(child, lanes);
    child = child.sibling;
  }
}
