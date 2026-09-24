const PREPARE_NOTICE_PARTS = {
  lead: "This is not legal advice.",
  detail: "It is a plain-language summary to help you prepare for a conversation with a qualified lawyer about this document.",
} as const;

export const LEGAL_ADVICE_COPY = {
  short: "Saboot explains documents. It isn't legal advice.",
  prepareLead: PREPARE_NOTICE_PARTS.lead,
  prepareDetail: PREPARE_NOTICE_PARTS.detail,
  prepareNotice: `${PREPARE_NOTICE_PARTS.lead} ${PREPARE_NOTICE_PARTS.detail}`,
} as const;
