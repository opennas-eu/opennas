import { usePicker } from "../../store/picker.ts";
import { AppFilePicker } from "./AppFilePicker.tsx";

/** Renders whichever picker request is at the head of the queue, if any. */
export function AppPickerHost() {
  const request = usePicker((s) => s.queue[0]);
  const resolveTop = usePicker((s) => s.resolveTop);
  if (!request) return null;
  return (
    <AppFilePicker
      key={request.id}
      request={request}
      onPick={(choice) => resolveTop(choice)}
      onCancel={() => resolveTop(null)}
    />
  );
}
