import { describe, expect, it } from "vitest";
import contract from "@/lib/material-ingestion.contract.json";
import { initialMaterialOperation } from "@/lib/material-ingestion";

describe("initial material task contract", () => {
  it("routes document, Office, and media uploads for both owners", () => {
    expect(contract.version).toBe(1);
    expect(initialMaterialOperation("course", "pdf")).toBe("parse_and_index");
    expect(initialMaterialOperation("course", "PPTX")).toBe("convert_preview");
    expect(initialMaterialOperation("course", "mp4")).toBe("transcribe_and_index");
    expect(initialMaterialOperation("personal", "md")).toBe("personal_parse_and_index");
    expect(initialMaterialOperation("personal", "docx")).toBe("personal_convert_preview");
    expect(initialMaterialOperation("personal", "M4A")).toBe("personal_transcribe_and_index");
  });
});
