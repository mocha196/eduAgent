import type { Tool, OpenAITool } from "./types";
import { z } from "zod";

type ToolInputValidator = ReturnType<typeof z.fromJSONSchema>;

/**
 * Normalise the public tool contract once, before it is sent to the model or
 * compiled into a runtime validator. Tool inputs are closed objects by
 * default: an LLM must not be able to smuggle undeclared fields into execute().
 */
export function normaliseToolParameters(parameters: Tool["parameters"]): Tool["parameters"] {
  if (parameters.type !== "object" || parameters.additionalProperties !== undefined) {
    return parameters;
  }
  return { ...parameters, additionalProperties: false };
}

export function compileToolParameters(parameters: Tool["parameters"]): ToolInputValidator {
  return z.fromJSONSchema(
    normaliseToolParameters(parameters) as Parameters<typeof z.fromJSONSchema>[0],
  );
}

export class ToolRegistry {
  private _tools = new Map<string, Tool>();
  private _validators = new Map<string, ToolInputValidator>();

  register(tool: Tool): void {
    // Compile eagerly so an invalid schema fails during application startup,
    // rather than only after the model tries to call the tool.
    const validator = compileToolParameters(tool.parameters);
    this._tools.set(tool.name, tool);
    this._validators.set(tool.name, validator);
  }

  get(name: string): Tool | undefined {
    return this._tools.get(name);
  }

  getAll(): Tool[] {
    return [...this._tools.values()];
  }

  getValidator(name: string): ToolInputValidator | undefined {
    return this._validators.get(name);
  }

  getSchemas(): OpenAITool[] {
    return this.getAll().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: normaliseToolParameters(t.parameters),
      },
    }));
  }
}
