import BackButton from "@/components/BackButton";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-svh bg-white text-gray-900">
      <BackButton />
      {children}
    </div>
  );
}
