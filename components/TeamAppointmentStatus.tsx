import type {TeamAppointment,TeamAppointmentStatus} from "@/lib/salesTeams/calendarTypes";
const labels:Record<TeamAppointmentStatus,string>={
 awaiting_confirmation:"Awaiting calendar confirmation",scheduled:"Scheduled",rescheduling:"Confirming new time",
 canceling:"Confirming cancellation",canceled:"Canceled",not_scheduled:"Not booked",review_required:"Appointment needs review"
};
export default function TeamAppointmentStatus({appointments}:{appointments?:TeamAppointment[]}){
 if(!appointments?.length)return <p>Appointment awaiting confirmation.</p>;
 return <div aria-label="Appointment status">{appointments.map((item,index)=><div key={item.assignmentRevision+":"+item.membershipId+":"+index}>
  <p>{labels[item.status]}{item.scheduledAt?<>{item.status==="rescheduling"?" · Current time: ":" · "}<time dateTime={item.scheduledAt}>{new Date(item.scheduledAt).toLocaleString()}</time></>:null}</p>
  {item.status==="rescheduling"&&item.requestedAt?<p>Requested new time: <time dateTime={item.requestedAt}>{new Date(item.requestedAt).toLocaleString()}</time></p>:null}
  {item.previousAssignment?<p>{item.status==="canceled"||item.status==="not_scheduled"
   ?"The earlier appointment is closed. The buyer can book with the current assigned closer."
   :"This appointment stays with the previous closer. The buyer must cancel it before booking with the current closer."}</p>:null}
 </div>)}</div>;
}
