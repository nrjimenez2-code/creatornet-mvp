export type TeamAppointmentStatus="awaiting_confirmation"|"scheduled"|"rescheduling"|"canceling"|"canceled"|"not_scheduled"|"review_required";
/** Small customer-facing projection. Provider IDs, account data, raw events and
 * financial objects are deliberately outside this contract. */
export type TeamAppointment={
 provider:"google";status:TeamAppointmentStatus;assignmentRevision:number;membershipId:string;targetId:string;
 scheduledAt:string|null;requestedAt:string|null;observedAt:string|null;previousAssignment:boolean;
};
