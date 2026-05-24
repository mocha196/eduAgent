/**
 * Tool registry singleton — registers all tools for the TS Agent.
 */

export { toolRegistry } from "./registry";
import { toolRegistry } from "./registry";
import { knowledgeQueryTool /* generateQuizTool */ } from "./rag";
import { rememberFactTool, searchMemoryTool } from "./memory";
import { listSkillsTool, viewSkillTool } from "./skills";
import { parseDocumentTool } from "./ocr";
import { analyzeImageTool } from "./vision";
import { getCourseInfoTool, listCourseMaterialsTool, getMaterialSummaryTool, viewCurrentMaterialPageTool } from "./course";
import { execSkillScriptTool } from "./exec";
import { runScriptTool } from "./runscript";
import { readAttachmentTool } from "./read-attachment";

// RAG tools
toolRegistry.register(knowledgeQueryTool);
// toolRegistry.register(generateQuizTool);

// Memory tools
toolRegistry.register(rememberFactTool);
toolRegistry.register(searchMemoryTool);

// Skills tools
toolRegistry.register(listSkillsTool);
toolRegistry.register(viewSkillTool);

// OCR / document parsing
toolRegistry.register(parseDocumentTool);

// Vision tool — image understanding via dedicated vision model
toolRegistry.register(analyzeImageTool);

// Course structure tools — metadata, material lists, summaries
toolRegistry.register(getCourseInfoTool);
toolRegistry.register(listCourseMaterialsTool);
toolRegistry.register(getMaterialSummaryTool);
toolRegistry.register(viewCurrentMaterialPageTool);

// Anthropic skills mechanism — script execution proxy (delegates to rag-service)
toolRegistry.register(execSkillScriptTool);

// Arbitrary code execution — requires explicit user approval before running
toolRegistry.register(runScriptTool);

// Read text/code attachment content by ID (up to 32 KB)
toolRegistry.register(readAttachmentTool);

// delegation tool — imported after other tools to avoid circular import issue
import { delegateTaskTool } from "./delegation";
toolRegistry.register(delegateTaskTool);

export { knowledgeQueryTool /* generateQuizTool */ };
export { rememberFactTool, searchMemoryTool };
export { listSkillsTool, viewSkillTool };
export { parseDocumentTool };
export { delegateTaskTool };
export { analyzeImageTool };
export { getCourseInfoTool, listCourseMaterialsTool, getMaterialSummaryTool };
export { execSkillScriptTool };
