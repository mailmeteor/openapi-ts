/**
 * This file is part of the `@hey-api/sdk` plugin in `openapi-ts`.
 *
 * In OpenAPI, an "operation" is a single endpoint + HTTP method (for example
 * `GET /users/{id}`), described by:
 * - path template (`/users/{id}`)
 * - method (`get`, `post`, ...)
 * - parameters (`path`, `query`, `header`, `cookie`)
 * - request body (content type + JSON Schema)
 * - responses (status codes + content types + schemas)
 * - security requirements (bearer auth, api keys, etc.)
 *
 * The role of this module is to take an `IR.OperationObject` (the library's
 * internal representation of an OpenAPI operation) and produce *codegen output*
 * for the generated TypeScript SDK:
 * 1) The TypeScript method signature (what SDK users will call).
 * 2) The statements inside the method body (how the call becomes an HTTP request).
 *
 * Important: this code does not execute HTTP requests itself. It *builds*
 * TypeScript AST nodes using the `ts-dsl` builder (`$`). Those nodes are later
 * printed to `.ts` files by the generator.
 *
 * How this fits the broader OpenAPI scope:
 * - OpenAPI gives us raw API semantics (params, bodies, content types, security).
 * - The `@hey-api/typescript` plugin turns OpenAPI schemas into TypeScript types
 *   (e.g. `OperationIdData`, `OperationIdResponse`, `OperationIdErrors`).
 * - The `@hey-api/sdk` plugin turns those types + operation metadata into
 *   ergonomic SDK methods, and wires them to runtime "client-core" helpers
 *   (serialization, validation hooks, response parsing hints, etc.).
 */
import type { SymbolMeta } from '@hey-api/codegen-core';
import { refs } from '@hey-api/codegen-core';
import type { IR } from '@hey-api/shared';
import { statusCodeToGroup } from '@hey-api/shared';

import { getTypedConfig } from '../../../../config/utils';
import { getClientPlugin } from '../../../../plugins/@hey-api/client-core/utils';
import { $ } from '../../../../ts-dsl';
import type { TypeTsDsl } from '../../../../ts-dsl/base';
import type { Field, Fields } from '../../client-core/bundle/params';
import type { HeyApiSdkPlugin } from '../types';
import { isInstance } from '../v1/node';
import { operationAuth } from './auth';
import { nuxtTypeComposable, nuxtTypeDefault } from './constants';
import { getSignatureParameters } from './signature';
import { createRequestValidator, createResponseValidator } from './validator';

/**
 * Build the TypeScript type for the final `options` argument of a generated SDK
 * operation method.
 *
 * In the generated SDK, most methods look conceptually like:
 *
 * ```ts
 * // (actual signature shape depends on config + client)
 * function getUser(/* params... *\/, options?: ClientOptions<...>) { ... }
 * ```
 *
 * That `ClientOptions<...>` type is a shared runtime type exposed by the SDK's
 * client layer (think: headers, query serializer overrides, per-request client
 * instance override, request/response validators, etc.).
 *
 * Why this lives in the "operation" layer:
 * - `ClientOptions` itself is generic, and some of its generic parameters are
 *   operation-specific (for example the "data" payload shape, or the error type).
 * - Different runtime clients (Axios vs Fetch vs Nuxt composables) expose
 *   slightly different option-type shapes, so we branch on client kind.
 *
 * Notes:
 * - `isDataAllowed` toggles whether we should thread the operation "data" type
 *   through options. This is mainly relevant when the SDK signature is grouped
 *   (single `data` object) vs flattened (positional/flat params).
 * - `throwOnError` is threaded as a generic for non-Nuxt clients, because
 *   "throwing vs returning errors" is represented as a type-level boolean.
 *
 */
export const operationOptionsType = ({
  isDataAllowed = true,
  operation,
  plugin,
  throwOnError,
}: {
  isDataAllowed?: boolean;
  operation: IR.OperationObject;
  plugin: HeyApiSdkPlugin['Instance'];
  throwOnError?: string;
}): ReturnType<typeof $.type> => {
  /**
   * The SDK plugin is not the only plugin participating in generation.
   * We also have a "client-core" plugin that defines the runtime client,
   * plus a TypeScript plugin that generates operation-specific types.
   *
   * Here we detect which runtime client is in use because it affects the
   * shape of `options` generics (Nuxt composables have different typing).
   */
  const client = getClientPlugin(getTypedConfig(plugin));
  const isNuxtClient = client.name === '@hey-api/client-nuxt';

  /**
   * The TypeScript plugin generates a `...Data` type for each OpenAPI operation.
   * In OpenAPI terms it is an object like:
   * - `body`    (requestBody)
   * - `path`    (path params)
   * - `query`   (query params)
   * - `headers` (header params)
   * - `url`     (the path template constant)
   *
   * Depending on SDK signature configuration, we may or may not want to expose
   * that grouped "data" type via the `options` generics.
   */
  const symbolDataType = isDataAllowed
    ? plugin.querySymbol({
        category: 'type',
        resource: 'operation',
        resourceId: operation.id,
        role: 'data',
        tool: 'typescript',
      })
    : undefined;

  /**
   * `client-options` is a shared runtime type (from the SDK/client layer) that
   * represents the *per-request* configuration the SDK user can pass.
   *
   * We reference it here and then specialize it with operation-specific
   * generics (data type, response type, error type, "throwOnError", ...).
   */
  const symbolOptions = plugin.referenceSymbol({
    category: 'type',
    resource: 'client-options',
    tool: 'sdk',
  });

  if (isNuxtClient) {
    /**
     * Nuxt client methods return composables and allow customizing the
     * composable implementation type. Their `ClientOptions` generics differ
     * from other clients, so we build:
     *
     * `ClientOptions<TComposable, DataT, ResponseT, DefaultT>`
     *
     * (names simplified; see `constants.ts` for the actual generic identifiers).
     */
    const symbolResponseType = plugin.querySymbol({
      category: 'type',
      resource: 'operation',
      resourceId: operation.id,
      role: 'response',
    });
    return $.type(symbolOptions)
      .generic(nuxtTypeComposable)
      .generic(isDataAllowed ? (symbolDataType ?? 'unknown') : 'never')
      .generic(symbolResponseType ?? 'unknown')
      .generic(nuxtTypeDefault);
  }

  // TODO: refactor this to be more generic, works for now
  if (throwOnError) {
    /**
     * Non-Nuxt clients thread a `ThrowOnError` boolean through the type system.
     * It affects whether the runtime client rejects on non-2xx responses, and
     * therefore the return type of the generated SDK method.
     */
    return $.type(symbolOptions)
      .generic(isDataAllowed ? (symbolDataType ?? 'unknown') : 'never')
      .generic(throwOnError);
  }
  return $.type(symbolOptions).$if(!isDataAllowed || symbolDataType, (t) =>
    t.generic(isDataAllowed ? symbolDataType! : 'never'),
  );
};

type OperationParameters = {
  /**
   * Names of arguments *in call order* (excluding `options`), as they will
   * appear in the generated SDK method signature. `operationStatements()` uses
   * this list to build a runtime `args` array.
   */
  argNames: Array<string>;
  /**
   * Declarative mapping that tells the runtime helper (`buildClientParams`)
   * where each argument/property should go: `path`, `query`, `headers`, `body`.
   *
   * This mapping exists because OpenAPI names and SDK parameter names can
   * differ (naming conflicts, casing, aliasing), and because we support
   * different SDK signature styles.
   */
  fields: Array<Field | Fields>;
  /**
   * If true, `fields` is already aligned to `argNames` (one entry per argument).
   * If false, we wrap `fields` under a single `{ args: ... }` object to indicate
   * that a single argument (typically the `parameters` object) contains multiple
   * fields.
   */
  fieldsByArgument: boolean;
  /**
   * The TypeScript AST nodes for the generated method parameters.
   * This is what ultimately becomes the `(foo, bar, options)` signature in the
   * printed SDK code.
   */
  parameters: Array<ReturnType<typeof $.param>>;
};

export function operationParameters({
  isRequiredOptions,
  operation,
  plugin,
}: {
  isRequiredOptions: boolean;
  operation: IR.OperationObject;
  plugin: HeyApiSdkPlugin['Instance'];
}): OperationParameters {
  /**
   * This function is the "signature builder" for an OpenAPI operation.
   *
   * OpenAPI itself doesn't tell you what an ergonomic SDK function signature is.
   * For the same operation, you might prefer:
   *
   * - Grouped style:
   *   `sdk.getUser({ path: { id }, query: { includePosts: true } }, options)`
   *
   * - Flat style:
   *   `sdk.getUser({ id, includePosts: true }, options)`
   *
   * - Flat style with positional path params:
   *   `sdk.getUser(id, { includePosts: true }, options)`
   *
   * The output of this function feeds into `operationStatements()` which needs
   * both the generated parameter list and a mapping that can reconstruct the
   * OpenAPI slots (`path`, `query`, `headers`, `body`) at runtime.
   */
  const result: OperationParameters = {
    argNames: [],
    fields: [],
    fieldsByArgument: false,
    parameters: [],
  };

  const pluginTypeScript = plugin.getPluginOrThrow('@hey-api/typescript');
  const client = getClientPlugin(getTypedConfig(plugin));
  const isNuxtClient = client.name === '@hey-api/client-nuxt';

  /**
   * "Flat" paramsStructure means we aim for a flattened/ergonomic SDK signature.
   * We start by building a canonical "signature" model of all operation inputs
   * (from OpenAPI parameters + requestBody). That model handles name conflicts
   * (e.g. a `id` query param and `id` path param) and produces `Field` mappings.
   */
  if (plugin.config.paramsStructure === 'flat') {
    const signature = getSignatureParameters({ operation, plugin });

    if (signature) {
      const usePositionalPathParams = plugin.config.positionalPathParams;

      /**
       * Path parameters are special in OpenAPI: they appear as `{param}` tokens
       * in the path template, and their ordering is visible to humans.
       *
       * If `positionalPathParams` is enabled, we pull path params out of the
       * flattened object and expose them as positional arguments *in the order
       * they appear in the path template*. Example:
       *
       * - OpenAPI path: `/orgs/{orgId}/users/{userId}`
       * - Signature:   `fn(orgId, userId, parameters?, options?)`
       *
       * The remaining params (query/header/body) stay in the `parameters` object.
       */
      type PathField = {
        in: 'path';
        key: string;
        map?: string;
      };

      const pathFields = signature.fields.filter(
        (field): field is PathField =>
          'in' in field && field.in === 'path' && typeof field.key === 'string',
      );
      const pathFieldByKey = new Map<string, PathField>();
      const signatureKeyByOriginalName = new Map<string, string>();

      for (const field of pathFields) {
        pathFieldByKey.set(field.key, field);
        const originalName = field.map ?? field.key;
        signatureKeyByOriginalName.set(originalName, field.key);
      }

      const positionalPathKeys: Array<string> = [];
      if (usePositionalPathParams && signatureKeyByOriginalName.size) {
        /**
         * Extract `{param}` tokens from the OpenAPI path template to decide the
         * positional argument order. We preserve the template order and de-dupe
         * repeated tokens.
         */
        const seenOriginalNames = new Set<string>();
        const pathParamPattern = /\{([^}]+)\}/g;
        let match: RegExpExecArray | null;
        while ((match = pathParamPattern.exec(operation.path))) {
          const originalName = match[1];
          if (!originalName || seenOriginalNames.has(originalName)) {
            continue;
          }
          const signatureKey = signatureKeyByOriginalName.get(originalName);
          if (signatureKey) {
            positionalPathKeys.push(signatureKey);
            seenOriginalNames.add(originalName);
          }
        }

        // Add any remaining path params not found in the template (should be rare).
        for (const [originalName, signatureKey] of signatureKeyByOriginalName.entries()) {
          if (!seenOriginalNames.has(originalName)) {
            positionalPathKeys.push(signatureKey);
          }
        }
      }

      const positionalPathKeysSet = new Set(positionalPathKeys);
      const hasPositionalPathParams = positionalPathKeys.length > 0;

      if (hasPositionalPathParams) {
        /**
         * For each positional path parameter, we:
         * - add it to the generated SDK method signature (`result.parameters`)
         * - remember its argument name (`result.argNames`)
         * - record a `Field` mapping telling the runtime it belongs in the `path` slot
         *
         * At runtime, `buildClientParams([arg1, arg2, ...], fieldsConfig)` will
         * rebuild `{ path: { ... } }` from these positional values.
         */
        for (const signatureKey of positionalPathKeys) {
          const pathSignature = signature.parameters[signatureKey];
          if (!pathSignature) {
            continue;
          }

          // Add positional path arg name in the SDK signature.
          result.argNames.push(pathSignature.name);

          // Record the field mapping for the positional path arg.
          const pathField = pathFieldByKey.get(signatureKey);
          result.fields.push({
            in: 'path',
            key: pathSignature.name,
            ...(pathField?.map ? { map: pathField.map } : {}),
          });

          /**
           * Convert the OpenAPI schema for this parameter into a TypeScript type.
           * This is delegated to the `@hey-api/typescript` plugin, which knows how
           * to translate JSON Schema + OpenAPI schema features into TS.
           */
          const pathType = pluginTypeScript.api.schemaToType({
            plugin: pluginTypeScript,
            schema: pathSignature.schema,
            state: refs({
              path: [],
            }),
          });
          result.parameters.push(
            $.param(pathSignature.name, (p) =>
              p.required(pathSignature.isRequired).type(pathType as TypeTsDsl),
            ),
          );
        }
      }

      const nonPositionalFields = hasPositionalPathParams
        ? signature.fields.filter(
            (field) =>
              !('in' in field && field.in === 'path' && positionalPathKeysSet.has(field.key)),
          )
        : signature.fields;

      /**
       * Next we build the (optional) `parameters` object argument that contains
       * everything that is *not* positional: query params, headers, and request body.
       *
       * We keep track of whether any of those parameters are required so that
       * the resulting `parameters` argument can be required/optional correctly.
       */
      const flatParams = $.type.object();
      let isParametersRequired = false;
      let hasNonPathParams = false;

      for (const key in signature.parameters) {
        if (hasPositionalPathParams && positionalPathKeysSet.has(key)) {
          continue;
        }
        hasNonPathParams = true;
        const parameter = signature.parameters[key]!;
        if (parameter.isRequired) {
          isParametersRequired = true;
        }
        const paramType = pluginTypeScript.api.schemaToType({
          plugin: pluginTypeScript,
          schema: parameter.schema,
          state: refs({
            path: [],
          }),
        });
        flatParams.prop(parameter.name, (p) =>
          p.required(parameter.isRequired).type(paramType as TypeTsDsl),
        );
      }

      if (hasNonPathParams) {
        /**
         * If there are any non-positional values, we emit a `parameters` argument:
         *
         * - If we also have positional path params, `fields` needs to be aligned
         *   to argument order: `[pathArg1Field, pathArg2Field, { args: remainingFields }]`.
         *
         * - If we *don't* have positional args, then the single `parameters` object
         *   contains all fields, so we can store `signature.fields` directly and let
         *   `operationStatements()` wrap it as `{ args: fields }`.
         */
        result.argNames.push('parameters');

        if (hasPositionalPathParams) {
          result.fields.push({
            args: nonPositionalFields,
          });
          // Fields are aligned to arguments (positional path... + parameters).
          result.fieldsByArgument = true;
        } else {
          // Store the full field mapping for the flattened object.
          result.fields.push(...signature.fields);
          // Keep fieldsByArgument false so we wrap fields as args later.
          result.fieldsByArgument = false;
        }

        result.parameters.push(
          $.param('parameters', (p) => p.required(isParametersRequired).type(flatParams)),
        );
      } else if (hasPositionalPathParams) {
        /**
         * Edge case: the operation only has path params and we exposed them
         * positionally. In that case there is no `parameters` object at all.
         */
        // Only positional path params, no `parameters` object.
        result.fieldsByArgument = true;
      }
    }
  }

  /**
   * The final argument of every generated operation method is `options`.
   *
   * This is where users pass per-request knobs that are not part of the OpenAPI
   * "data" model: overriding headers, choosing a client instance, configuring
   * serialization/validation behavior, etc.
   *
   * The type for `options` is operation-specific because it is generic over the
   * operation's data/response/error types, and client-specific because different
   * runtime clients (Nuxt, Axios, Fetch) have different option generic shapes.
   */
  result.parameters.push(
    $.param('options', (p) =>
      p.required(isRequiredOptions).type(
        operationOptionsType({
          isDataAllowed: plugin.config.paramsStructure === 'grouped',
          operation,
          plugin,
          throwOnError: isNuxtClient ? undefined : 'ThrowOnError',
        }),
      ),
    ),
  );

  return result;
}

/**
 * Infers `responseType` value from provided response content type. This is
 * an adapted version of `getParseAs()` from the Fetch API client.
 *
 * From Axios documentation:
 * `responseType` indicates the type of data that the server will respond with
 * options are: 'arraybuffer', 'document', 'json', 'text', 'stream'
 * browser only: 'blob'
 */
const getResponseType = (
  contentType: string | null | undefined,
): 'arraybuffer' | 'blob' | 'document' | 'json' | 'stream' | 'text' | undefined => {
  /**
   * OpenAPI describes response bodies via "media types" (for example
   * `application/json`, `text/plain`, `application/octet-stream`).
   *
   * Some runtime clients (notably Axios) need a hint about how to interpret the
   * response body (`responseType`) to return the right shape. Other clients
   * (fetch/ofetch) can typically infer this at runtime.
   *
   * This helper takes a raw `Content-Type` header value and maps it to the small
   * set of Axios `responseType` values we support.
   */
  if (!contentType) {
    return;
  }

  const cleanContent = contentType.split(';')[0]?.trim();

  if (!cleanContent) {
    return;
  }

  if (cleanContent.startsWith('application/json') || cleanContent.endsWith('+json')) {
    return 'json';
  }

  // Axios does not handle form data out of the box
  // if (cleanContent === 'multipart/form-data') {
  //   return 'formData';
  // }

  if (
    ['application/', 'audio/', 'image/', 'video/'].some((type) => cleanContent.startsWith(type))
  ) {
    return 'blob';
  }

  if (cleanContent.startsWith('text/')) {
    return 'text';
  }

  return;
};

export function operationStatements({
  isRequiredOptions,
  opParameters,
  operation,
  plugin,
}: {
  isRequiredOptions: boolean;
  opParameters: OperationParameters;
  operation: IR.OperationObject;
  plugin: HeyApiSdkPlugin['Instance'];
}): Array<ReturnType<typeof $.return | typeof $.const>> {
  /**
   * This function builds the *method body* for a generated SDK operation.
   *
   * The output is a list of TypeScript statements (as ts-dsl nodes), typically:
   * - optional `const params = buildClientParams(...)` to reconstruct `{ path, query, headers, body }`
   * - `return client.<method>({ ...requestOptions, ...params, ...options })` with the right generics
   *
   * The method body is where OpenAPI semantics become runtime configuration:
   * - parameter serialization (`style`/`explode`)
   * - request body serialization (JSON vs form-data vs text/binary)
   * - response parsing hints (Axios `responseType`)
   * - security/auth configuration from OpenAPI `security`
   * - optional validation hooks
   */
  const client = getClientPlugin(getTypedConfig(plugin));
  const isNuxtClient = client.name === '@hey-api/client-nuxt';

  /**
   * The TypeScript plugin emits operation-specific response and error types.
   * We look them up by symbol metadata so the SDK method can be correctly typed.
   *
   * Nuxt client uses singular `response`/`error` types; other clients use
   * `responses`/`errors` maps (then the client picks the right one at runtime).
   */
  const symbolResponseType = plugin.querySymbol({
    category: 'type',
    resource: 'operation',
    resourceId: operation.id,
    role: isNuxtClient ? 'response' : 'responses',
  });

  const symbolErrorType = plugin.querySymbol({
    category: 'type',
    resource: 'operation',
    resourceId: operation.id,
    role: isNuxtClient ? 'error' : 'errors',
  });

  // TODO: transform parameters
  // const query = {
  //   BarBaz: options.query.bar_baz,
  //   qux_quux: options.query.qux_quux,
  //   fooBar: options.query.foo_bar,
  // };

  // if (operation.parameters) {
  //   for (const name in operation.parameters.query) {
  //     const parameter = operation.parameters.query[name]
  //     if (parameter.name !== fieldName({ context, name: parameter.name })) {
  //       console.warn(parameter.name)
  //     }
  //   }
  // }

  /**
   * `reqOptions` is the configuration object that will be passed to the runtime
   * client method (`client.get(...)`, `client.post(...)`, ...).
   *
   * Think of it as the "compiled" form of OpenAPI operation metadata +
   * generator configuration + user-provided `options`.
   */
  const reqOptions = $.object();

  if (operation.body) {
    /**
     * OpenAPI request bodies have a media type (`content-type`) and a schema.
     * Our runtime clients support pluggable "body serializers".
     *
     * Default behavior:
     * - JSON body uses a JSON serializer by default.
     * - Some media types need explicit serializers (form-data, url-search-params).
     * - Binary payloads should not go through JSON serialization.
     *
     * Here we emit per-operation overrides that instruct the runtime how to
     * serialize the request body.
     */
    // Check if body has binary format - if so, don't use JSON serializer
    const isBinaryFormat = operation.body.schema?.format === 'binary';

    switch (operation.body.type) {
      case 'form-data': {
        const symbol = plugin.external('client.formDataBodySerializer');
        reqOptions.spread(symbol);
        break;
      }
      case 'json':
        // jsonBodySerializer is the default, no need to specify
        // unless the schema has binary format
        if (isBinaryFormat) {
          reqOptions.prop('bodySerializer', $.literal(null));
        }
        break;
      case 'text':
      case 'octet-stream':
        // ensure we don't use any serializer by default
        reqOptions.prop('bodySerializer', $.literal(null));
        break;
      case 'url-search-params': {
        const symbol = plugin.external('client.urlSearchParamsBodySerializer');
        reqOptions.spread(symbol);
        break;
      }
      default:
        // For unrecognized media types with binary format, don't use JSON serializer
        if (isBinaryFormat) {
          reqOptions.prop('bodySerializer', $.literal(null));
        }
        break;
    }
  }

  // TODO: parser - set parseAs to skip inference if every response has the same
  // content type. currently impossible because successes do not contain
  // header information

  const paramSerializers = $.object();

  for (const name in operation.parameters?.query) {
    const parameter = operation.parameters.query[name]!;

    /**
     * OpenAPI query parameters can specify `style` and `explode` which define
     * how complex values are serialized into the query string.
     *
     * Our runtime has sane defaults (`form` for arrays, `deepObject` for objects),
     * but if the OpenAPI operation overrides them we emit a `querySerializer`
     * configuration so runtime serialization matches the spec.
     */
    if (parameter.schema.type === 'array' || parameter.schema.type === 'tuple') {
      if (parameter.style !== 'form' || !parameter.explode) {
        // override the default settings for array serialization
        paramSerializers.prop(
          parameter.name,
          $.object().prop(
            'array',
            $.object()
              .$if(parameter.explode === false, (o) =>
                o.prop('explode', $.literal(parameter.explode)),
              )
              .$if(parameter.style !== 'form', (o) => o.prop('style', $.literal(parameter.style))),
          ),
        );
      }
    } else if (parameter.schema.type === 'object') {
      if (parameter.style !== 'deepObject' || !parameter.explode) {
        // override the default settings for object serialization
        paramSerializers.prop(
          parameter.name,
          $.object().prop(
            'object',
            $.object()
              .$if(parameter.explode === false, (o) =>
                o.prop('explode', $.literal(parameter.explode)),
              )
              .$if(parameter.style !== 'deepObject', (o) =>
                o.prop('style', $.literal(parameter.style)),
              ),
          ),
        );
      }
    }
  }

  if (paramSerializers.hasProps()) {
    /**
     * Emit query serializer overrides only when needed, to keep generated code small.
     * The runtime can apply these per-parameter settings when building the URL.
     */
    // TODO: if all parameters have the same serialization,
    // apply it globally to reduce output size
    reqOptions.prop('querySerializer', $.object().prop('parameters', paramSerializers));
  }

  const requestValidator = createRequestValidator({ operation, plugin });
  const responseValidator = createResponseValidator({ operation, plugin });
  if (requestValidator) {
    /**
     * Optional hook: validate requests before sending them.
     * This is configured via plugin config (`validator.request`) and implemented
     * by another plugin (e.g. Zod).
     */
    reqOptions.prop('requestValidator', requestValidator.arrow());
  }

  if (plugin.config.transformer) {
    /**
     * Optional hook: transform the successful response before returning it.
     * This is a user-configured codegen "transform" symbol, registered elsewhere.
     */
    const query: SymbolMeta = {
      category: 'transform',
      resource: 'operation',
      resourceId: operation.id,
      role: 'response',
    };
    if (plugin.isSymbolRegistered(query)) {
      const ref = plugin.referenceSymbol(query);
      reqOptions.prop('responseTransformer', $(ref));
    }
  }

  let hasServerSentEvents = false;
  let responseTypeValue: ReturnType<typeof getResponseType> | undefined;

  for (const statusCode in operation.responses) {
    const response = operation.responses[statusCode]!;

    /**
     * Axios needs an explicit `responseType` to correctly handle non-JSON bodies
     * (e.g. binary downloads). OpenAPI tells us the media type for responses, so
     * we infer a reasonable `responseType` from the first 2xx response we find.
     *
     * This inference is only emitted for the Axios client; fetch-based clients
     * can decide at runtime.
     */
    // try to infer `responseType` option for Axios. We don't need this in
    // Fetch API client because it automatically detects the correct response
    // during runtime.
    if (!responseTypeValue && client.name === '@hey-api/client-axios') {
      // this doesn't handle default status code for now
      if (statusCodeToGroup({ statusCode }) === '2XX') {
        responseTypeValue = getResponseType(response.mediaType);
        if (responseTypeValue) {
          reqOptions.prop('responseType', $.literal(responseTypeValue));
        }
      }
    }

    /**
     * If the operation can return `text/event-stream`, we treat it as a Server-Sent
     * Events (SSE) endpoint and route the call through the runtime SSE helper.
     */
    if (response.mediaType === 'text/event-stream') {
      hasServerSentEvents = true;
    }
  }

  if (responseValidator) {
    /**
     * Optional hook: validate responses before returning them.
     * Like request validation, this is delegated to a validator plugin.
     */
    reqOptions.prop('responseValidator', responseValidator.arrow());
  }

  if (plugin.config.responseStyle === 'data') {
    /**
     * Some clients return a richer "response object" (status, headers, data).
     * `responseStyle: 'data'` tells the runtime to return only the `data` payload,
     * which is often what SDK users want.
     */
    reqOptions.prop('responseStyle', $.literal(plugin.config.responseStyle));
  }

  const auth = operationAuth({ context: plugin.context, operation, plugin });
  if (auth.length) {
    /**
     * OpenAPI `security` defines how an operation is authenticated.
     * `operationAuth` maps those security schemes into the runtime client's
     * expected "security" config so it can attach headers/query params/etc.
     */
    reqOptions.prop('security', $.fromValue(auth));
  }

  /**
   * The OpenAPI path template becomes the request URL.
   * Actual `path` parameter values are injected later via `buildClientParams`.
   */
  reqOptions.prop('url', $.literal(operation.path));

  // options must go last to allow overriding parameters above
  reqOptions.spread('options');

  const statements: Array<ReturnType<typeof $.return | typeof $.const>> = [];
  const hasParams = opParameters.argNames.length;

  if (hasParams) {
    /**
     * If the generated method signature has parameters (besides `options`), we
     * must translate them into the runtime "slots" `{ path, query, headers, body }`.
     *
     * The translation is done by `client.buildClientParams` (runtime helper),
     * using a declarative `fieldsConfig` that encodes:
     * - where each value belongs (`path` vs `query` vs `headers` vs `body`)
     * - whether a value needs name mapping (SDK name vs OpenAPI name)
     *
     * This allows the SDK signature to be ergonomic while still respecting the
     * OpenAPI-defined parameter locations and names.
     */
    const args: Array<ReturnType<typeof $.expr>> = [];
    for (const argName of opParameters.argNames) {
      args.push($(argName));
    }
    // Align fields config with argument order when required.
    const fieldsConfig = opParameters.fieldsByArgument
      ? opParameters.fields
      : [{ args: opParameters.fields }];

    const symbol = plugin.external('client.buildClientParams');
    statements.push(
      $.const('params').assign($(symbol).call($.array(...args), $.fromValue(fieldsConfig))),
    );

    reqOptions.spread('params');
  }

  if (operation.body) {
    /**
     * If the operation has a request body, we usually emit a `Content-Type` header
     * based on the OpenAPI media type.
     *
     * Exceptions:
     * - `multipart/form-data`: browsers set the boundary automatically; forcing
     *   the header can break uploads, so we set it to `null`.
     * - If the OpenAPI spec defines a required `content-type` header parameter,
     *   merging it with user options can become type-invalid, so we skip emitting
     *   an override in that case.
     */
    const parameterContentType = operation.parameters?.header?.['content-type'];
    const hasRequiredContentType = Boolean(parameterContentType?.required);
    // spreading required Content-Type on generated header would throw a TypeScript error
    if (!hasRequiredContentType) {
      const headers = $.object()
        .pretty()
        // form-data does not need Content-Type header, browser will set it automatically
        .prop(
          parameterContentType?.name ?? 'Content-Type',
          $.literal(operation.body.type === 'form-data' ? null : operation.body.mediaType),
        )
        .spread($('options').attr('headers').required(isRequiredOptions));
      if (hasParams) {
        headers.spread($('params').attr('headers'));
      }
      reqOptions.prop('headers', headers);
    }
  }

  /**
   * Decide which runtime client instance the operation should use.
   *
   * SDK users can always override it via `options.client`. Otherwise:
   * - For class-based SDK instances, we fall back to `this.client`.
   * - If the plugin is configured with a global client symbol, we fall back to it.
   * - Otherwise, `options.client` is required and must be provided by the user.
   */
  const symbolClient = plugin.config.client
    ? plugin.getSymbol({
        category: 'client',
      })
    : undefined;

  let clientExpression: ReturnType<typeof $.attr | typeof $.binary>;
  const optionsClient = $('options').attr('client').required(isRequiredOptions);
  if (isInstance(plugin)) {
    clientExpression = optionsClient.coalesce($('this').attr('client'));
  } else if (symbolClient) {
    clientExpression = optionsClient.coalesce(symbolClient);
  } else {
    clientExpression = optionsClient;
  }

  /**
   * Choose the actual function to call on the runtime client:
   * - SSE endpoints call `client.sse.<method>(...)`
   * - Normal endpoints call `client.<method>(...)`
   *
   * The method name comes from the OpenAPI operation (`get`, `post`, ...).
   */
  let functionName = hasServerSentEvents ? clientExpression.attr('sse') : clientExpression;
  functionName = functionName.attr(operation.method);

  statements.push(
    $.return(
      functionName
        .call(reqOptions)
        .$if(
          isNuxtClient,
          (f) =>
            f
              .generic(nuxtTypeComposable)
              .generic($.type.or(symbolResponseType ?? 'unknown', nuxtTypeDefault))
              .generic(symbolErrorType ?? 'unknown')
              .generic(nuxtTypeDefault),
          (f) =>
            f
              .generic(symbolResponseType ?? 'unknown')
              .generic(symbolErrorType ?? 'unknown')
              .generic('ThrowOnError'),
        )
        .$if(plugin.config.responseStyle === 'data', (f) =>
          f.generic($.type.literal(plugin.config.responseStyle)),
        ),
    ),
  );

  return statements;
}
