/**
 * Gate wording from the prototype. BI-04 (age policy) is OPEN: the minimum age, this copy and
 * the remembered duration are placeholders until the client's compliance review signs them off.
 */
export const MINIMUM_AGE = 18;
export const AGE_COPY = {
  badge: `Adults only · ${MINIMUM_AGE}+`,
  question: `Are you ${MINIMUM_AGE} or older?`,
  lead: `Iqos Haven sells nicotine and vaping products. This website is for adults aged ${MINIMUM_AGE} and over only.`,
  accept: `Yes, I am ${MINIMUM_AGE}+`,
  reject: `No, I am under ${MINIMUM_AGE}`,
  fine: (days: number) =>
    `By entering you confirm you are of legal age to buy these products in the UAE. Your age may be checked again on delivery. We remember your answer on this device for ${days} ${days === 1 ? "day" : "days"}.`,
  restrictedTitle: `You must be ${MINIMUM_AGE} or older to access Iqos Haven.`,
  restrictedLead:
    "This website sells age-restricted products, so we can't show you the store. Thank you for answering honestly.",
  leave: "Leave this site",
  footer: "Iqos Haven · Dubai, United Arab Emirates",
} as const;
