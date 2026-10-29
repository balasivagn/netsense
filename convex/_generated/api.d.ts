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
import type * as jobs from "../jobs.js";
import type * as sessions from "../sessions.js";
import type * as stageRuns from "../stageRuns.js";
import type * as students from "../students.js";
import type * as uploads from "../uploads.js";

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
  jobs: typeof jobs;
  sessions: typeof sessions;
  stageRuns: typeof stageRuns;
  students: typeof students;
  uploads: typeof uploads;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
