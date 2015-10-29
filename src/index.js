/* @flow */
/**
 *  Copyright (c) 2015, Facebook, Inc.
 *  All rights reserved.
 *
 *  This source code is licensed under the BSD-style license found in the
 *  LICENSE file in the root directory of this source tree. An additional grant
 *  of patent rights can be found in the PATENTS file in the same directory.
 */

import httpError from 'http-errors';
import { formatError } from 'graphql/error';
import { execute } from 'graphql/execution';
import { parse, Source } from 'graphql/language';
import { validate } from 'graphql/validation';
import { getOperationAST } from 'graphql/utilities/getOperationAST';
import { parseBody } from './parseBody';
import { renderGraphiQL } from './renderGraphiQL';
import type { Request, Response } from 'express';

/**
 * Used to configure the graphQLHTTP middleware by providing a schema
 * and other configuration options.
 */
export type Options = ((req: Request) => OptionsObj) | OptionsObj
export type OptionsObj = {
  /**
   * A GraphQL schema from graphql-js.
   */
  schema: Object,

  /**
   * An object to pass as the rootValue to the graphql() function.
   */
  rootValue?: ?Object,

  /**
   * A boolean to configure whether the output should be pretty-printed.
   */
  pretty?: ?boolean,

  /**
   * A boolean to optionally enable GraphiQL mode
   */
  graphiql?: ?boolean,
};

type Middleware = (request: Request, response: Response) => void;

/**
 * Middleware for express; takes an options object or function as input to
 * configure behavior, and returns an express middleware.
 */
export default function graphqlHTTP(options: Options): Middleware {
  if (!options) {
    throw new Error('GraphQL middleware requires options.');
  }

  return (request: Request, response: Response) => {
    // Get GraphQL options given this request.
    var { schema, rootValue, pretty, graphiql } = getOptions(options, request, response);

    // GraphQL HTTP only supports GET and POST methods.
    if (request.method !== 'GET' && request.method !== 'POST') {
      response.set('Allow', 'GET, POST');
      return sendError(
        response,
        httpError(405, 'GraphQL only supports GET and POST requests.'),
        pretty
      );
    }

    // Parse the Request body.
    parseBody(request, (parseError, data = {}) => {

      // Format any request errors the same as GraphQL errors.
      if (parseError) {
        return sendError(response, parseError, pretty);
      }

      // Get GraphQL params from the request and POST body data.
      var { query, variables, operationName } = getGraphQLParams(request, data);

      // If there is no query, present an empty GraphiQL if possible, otherwise
      // return a 400 level error.
      if (!query) {
        if (graphiql && canDisplayGraphiQL(request, data)) {
          return response
            .set('Content-Type', 'text/html')
            .send(renderGraphiQL());
        }
        throw httpError(400, 'Must provide query string.');
      }

      // Run GraphQL query.
      new Promise(resolve => {
        var source = new Source(query, 'GraphQL request');
        var documentAST = parse(source);
        var validationErrors = validate(schema, documentAST);
        if (validationErrors.length > 0) {
          resolve({ errors: validationErrors });
        } else {

          // Only query operations are allowed on GET requests.
          if (request.method === 'GET') {
            // Determine if this GET request will perform a non-query.
            var operationAST = getOperationAST(documentAST, operationName);
            if (operationAST && operationAST.operation !== 'query') {
              // If GraphiQL can be shown, do not perform this query, but
              // provide it to GraphiQL so that the requester may perform it
              // themselves if desired.
              if (graphiql && canDisplayGraphiQL(request, data)) {
                return response
                  .set('Content-Type', 'text/html')
                  .send(renderGraphiQL({ query, variables }));
              }

              // Otherwise, report a 405 Method Not Allowed error.
              response.set('Allow', 'POST');
              return sendError(
                response,
                httpError(
                  405,
                  `Can only perform a ${operationAST.operation} operation ` +
                  `from a POST request.`
                ),
                pretty
              );
            }
          }

          // Perform the execution.
          resolve(
            execute(
              schema,
              documentAST,
              rootValue,
              variables,
              operationName
            )
          );
        }
      }).catch(error => {
        return { errors: [ error ] };
      }).then(result => {

        // Format any encountered errors.
        if (result.errors) {
          result.errors = result.errors.map(formatError);
        }

        // Report 200:Success if a data key exists,
        // Otherwise 400:BadRequest if only errors exist.
        response.status(result.hasOwnProperty('data') ? 200 : 400);

        // If allowed to show GraphiQL, present it instead of JSON.
        if (graphiql && canDisplayGraphiQL(request, data)) {
          response
            .set('Content-Type', 'text/html')
            .send(renderGraphiQL({ query, variables, result }));
        } else {
          // Otherwise, present JSON directly.
          response
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(result, null, pretty ? 2 : 0));
        }
      });
    });
  };
}

/**
 * Get the options that the middleware was configured with, sanity
 * checking them.
 */
function getOptions(options: Options, request: Request, response: Response): OptionsObj {
  var optionsData = typeof options === 'function' ? options(request, response) : options;

  if (!optionsData || typeof optionsData !== 'object') {
    throw new Error(
      'GraphQL middleware option function must return an options object.'
    );
  }

  if (!optionsData.schema) {
    throw new Error(
      'GraphQL middleware options must contain a schema.'
    );
  }

  return optionsData;
}

type GraphQLParams = {
  query: ?string;
  variables: ?Object;
  operationName: ?string;
}

/**
 * Helper function to get the GraphQL params from the request.
 */
function getGraphQLParams(request: Request, data: Object): GraphQLParams {
  // GraphQL Query string.
  var query = request.query.query || data.query;

  // Parse the variables if needed.
  var variables = request.query.variables || data.variables;
  if (variables && typeof variables === 'string') {
    try {
      variables = JSON.parse(variables);
    } catch (error) {
      throw httpError(400, 'Variables are invalid JSON.');
    }
  }

  // Name of GraphQL operation to execute.
  var operationName = request.query.operationName || data.operationName;

  return { query, variables, operationName };
}

/**
 * Helper function to determine if GraphiQL can be displayed.
 */
function canDisplayGraphiQL(request: Request, data: Object): boolean {
  // If `raw` exists, GraphiQL mode is not enabled.
  var raw = request.query.raw !== undefined || data.raw !== undefined;
  // Allowed to show GraphiQL if not requested as raw and this request
  // prefers HTML over JSON.
  return !raw && request.accepts([ 'json', 'html' ]) === 'html';
}

/**
 * Helper for formatting errors
 */
function sendError(response: Response, error: Error, pretty?: ?boolean): void {
  var errorResponse = { errors: [ formatError(error) ] };
  response
    .status(error.status || 500)
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(errorResponse, null, pretty ? 2 : 0));
}
