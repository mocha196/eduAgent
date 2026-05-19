import type {
  MaterialPreviewPdfStatus,
  MaterialStatus,
} from "@prisma/client";

export type PersonalMaterialSummaryDto = {
  id: string;
  filename: string;
  file_type: string;
  status: MaterialStatus;
  preview_pdf_status: MaterialPreviewPdfStatus;
  indexed_chunk_count: number;
  created_at: string;
  status_message: string | null;
};

export type PersonalMaterialDetailDto = PersonalMaterialSummaryDto & {
  transcript: string | null;
  video_summary: string | null;
};

export type PersonalMaterialCreatedDto = {
  id: string;
  original_filename: string;
  status: MaterialStatus;
  created_at: string;
};
