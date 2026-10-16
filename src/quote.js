import { amount, guestCounts, nights, sha256 } from './domain.js';
import { cancellationEstimate, assertFreeCancellation } from './cancellation.js';
const TYPES=['ADULT','CHILD_A','CHILD_B','CHILD_C','CHILD_D','CHILD_F'];
export function verifyQuote(data, candidate, config) {
  if(data?.conflictExceptionForCandidateSet || data?.conflictExceptionsForCandidates?.some(Boolean)) throw new Error('INVENTORY_OR_QUOTE_CONFLICT');
  const cs=data?.candidateSet;
  const hotel=config.hotel;
  if(cs?.hotelCode!==hotel.code || (candidate.hotelCode&&candidate.hotelCode!==hotel.code) || cs.reservations?.length!==1)throw new Error('QUOTE_IDENTITY_MISMATCH');
  const r=cs.reservations[0];
  if(r.hotelCode!==hotel.code || r.planCode!==candidate.planCode || r.checkInDate!==candidate.stay.checkIn ||
    r.checkOutDate!==candidate.stay.checkOut || r.stays!==nights(candidate.stay) || r.roomTypes?.length!==1 ||
    r.roomTypes[0].roomTypeCode!==candidate.roomCode || r.roomTypes[0].rooms?.length!==1)throw new Error('QUOTE_IDENTITY_MISMATCH');
  const counts=guestCounts(config.guests), breakdown=r.roomTypes[0].rooms[0].lodgerTypeGenderBreakdowns;
  if(!Array.isArray(breakdown) || TYPES.some((t,i)=>Number(breakdown.find(b=>b.lodgerType===t)?.numberOfLodgers??0)!==counts[i]) ||
    breakdown.some(b=>!TYPES.includes(b.lodgerType)&&b.numberOfLodgers>0))throw new Error('QUOTE_GUEST_MISMATCH');
  const total=amount(cs.grandTotalCharge);
  if(!total || total!==candidate.totalJpy || total!==amount(r.totalCharge))throw new Error('QUOTE_PRICE_CHANGED');
  if(total+config.filters.extraTaxBudgetJpy>config.filters.maxTotalJpy)throw new Error('PRICE_LIMIT');
  if(r.options?.length || r.couponDiscounts?.length || r.adjustmentFee)throw new Error('UNEXPECTED_EXTRAS');
  const policy=r.cancellationPolicyDetails?.content;
  if(!policy)throw new Error('POLICY_MISSING');
  const payment=cs.paymentMethods?.filter(m=>!m.disabled);
  const supportedPayment=payment?.some(m=>m.type==='CREDIT_CARD'&&m.agent==='JBI')===true;
  if(['payment','auto'].includes(config.checkout.mode)&&!supportedPayment)throw new Error('UNSUPPORTED_PAYMENT_AGENT');
  // Unknown mandatory hotel questions require an explicit manual review.
  const questions=r.questionForms??[];
  const unresolvedQuestions=questions.filter(q=>q.required&&!hotel.questions.some(a=>a.code===q.code&&a.title===q.title&&a.formType===q.formType));
  if(config.checkout.mode!=='monitor'&&unresolvedQuestions.length)throw new Error('HOTEL_QUESTIONS_CHANGED');
  const estimate=cancellationEstimate(r.cancellationPolicyDetails,candidate.stay);
  if(['payment','auto'].includes(config.checkout.mode))assertFreeCancellation(estimate,config);
  return {totalJpy:total,cancellationPolicy:policy,policySha256:sha256(policy),
    cancellationRates:r.cancellationPolicyDetails.rate,cancellationEstimate:estimate,
    hotelCode:hotel.code,hotelName:cs.hotelDetails?.hotelName,supportedPayment,
    paymentMethods:payment?.map(m=>({type:m.type,agent:m.agent})),
    hotelFeatures:cs.hotelDetails?.additionalFeatures,questionForms:questions,
    unresolvedQuestions:unresolvedQuestions.map(q=>({code:q.code,title:q.title,formType:q.formType})),
    taxNotes:cs.hotelDetails?.taxDetailsNotes,terms:cs.termsAndConditions?.content,privacy:cs.privacyPolicy?.content};
}
