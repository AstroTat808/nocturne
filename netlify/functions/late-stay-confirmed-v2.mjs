import lateStayConfirmed from './late-stay-confirmed.mjs';
import { rewriteLateStayResponse } from './_late-stay-response.mjs';

export default async (req) => rewriteLateStayResponse(await lateStayConfirmed(req));
