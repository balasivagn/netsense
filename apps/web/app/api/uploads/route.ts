import { uploadHandler } from "../../../lib/upload/handler";
export const runtime = "nodejs";
const handle = uploadHandler("init");
export const POST = (request: Request) => handle(request);
