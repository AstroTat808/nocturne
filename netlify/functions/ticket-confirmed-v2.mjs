import ticketConfirmed from './ticket-confirmed.mjs';
import { rewriteLateStayResponse } from './_late-stay-response.mjs';

export default async (req) => rewriteLateStayResponse(await ticketConfirmed(req));
