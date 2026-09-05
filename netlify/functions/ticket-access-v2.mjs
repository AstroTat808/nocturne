import ticketAccess from './ticket-access.mjs';
import { rewriteLateStayResponse } from './_late-stay-response.mjs';

export default async (req) => rewriteLateStayResponse(await ticketAccess(req));
