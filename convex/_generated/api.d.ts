/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as coaches from "../coaches.js";
import type * as config from "../config.js";
import type * as http from "../http.js";
import type * as jobs from "../jobs.js";
import type * as persistenceValidators from "../persistenceValidators.js";
import type * as pipeline from "../pipeline.js";
import type * as sessions from "../sessions.js";
import type * as stageRuns from "../stageRuns.js";
import type * as students from "../students.js";
import type * as svc from "../svc.js";
import type * as uploads from "../uploads.js";
import type * as worker from "../worker.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  coaches: typeof coaches;
  config: typeof config;
  http: typeof http;
  jobs: typeof jobs;
  persistenceValidators: typeof persistenceValidators;
  pipeline: typeof pipeline;
  sessions: typeof sessions;
  stageRuns: typeof stageRuns;
  students: typeof students;
  svc: typeof svc;
  uploads: typeof uploads;
  worker: typeof worker;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
