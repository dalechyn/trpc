// import "server-only";

import type { TRPCLink } from '@trpc/client';
import { TRPCClientError } from '@trpc/client';
import {
  getTransformer,
  type TransformerOptions,
} from '@trpc/client/unstable-internals';
import { observable } from '@trpc/server/observable';
import type {
  AnyRouter,
  inferClientTypes,
  inferRouterContext,
} from '@trpc/server/unstable-core-do-not-import';
import { callProcedure } from '@trpc/server/unstable-core-do-not-import';
import { unstable_cache } from 'next/cache';
import { generateCacheTag } from '../shared';

type NextCacheLinkOptions<TRouter extends AnyRouter> = {
  router: TRouter;
  /**
   * define which values from the context should be considered into the cache
   * key
   */
  cacheContext: ((ctx: inferRouterContext<TRouter>) => any[]) | undefined;
  /** how many seconds the cache should hold before revalidating */
  revalidate?: number | false;
} & TransformerOptions<inferClientTypes<TRouter>>;

// ts-prune-ignore-next
export function experimental_nextCacheLink<TRouter extends AnyRouter>(
  opts: NextCacheLinkOptions<TRouter>,
): TRPCLink<TRouter> {
  const transformer = getTransformer(opts.transformer);
  return ({ createContext }) => {
    if (!createContext)
      throw new Error(
        '`createContext` is required to be passed to use `experimental_nextCacheLink`.',
      );

    return ({ op }) =>
      observable((observer) => {
        const { path, input, type, context } = op;

        // Let per-request revalidate override global revalidate
        const requestRevalidate =
          typeof context['revalidate'] === 'number' ||
          context['revalidate'] === false
            ? context['revalidate']
            : undefined;
        const revalidate = requestRevalidate ?? opts.revalidate ?? false;

        const promise = createContext()
          .then(async (ctx) => {
            const cacheTag = await generateCacheTag(
              path,
              input,
              opts.cacheContext?.(ctx),
            );

            const callProc = async (_cachebuster: string) => {
              //   // _cachebuster is not used by us but to make sure
              //   // that calls with different tags are properly separated
              //   // @link https://github.com/trpc/trpc/issues/4622
              const procedureResult = await callProcedure({
                procedures: opts.router._def.procedures,
                path,
                getRawInput: async () => input,
                ctx: ctx,
                type,
              });

              // We need to serialize cause the cache only accepts JSON
              return transformer.input.serialize(procedureResult);
            };

            if (type === 'query') {
              return unstable_cache(callProc, path.split('.'), {
                revalidate,
                tags: [cacheTag],
              })(cacheTag);
            }

            return callProc(cacheTag);
          })
          .catch((cause) => {
            observer.error(TRPCClientError.from(cause));
          });

        promise
          .then((data) => {
            const transformedResult = transformer.output.deserialize(data);
            observer.next({ result: { data: transformedResult } });
            observer.complete();
          })
          .catch((cause) => {
            observer.error(TRPCClientError.from(cause));
          });
      });
  };
}
