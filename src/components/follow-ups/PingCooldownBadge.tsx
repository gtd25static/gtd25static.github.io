import type { Task } from '../../db/models';
import { isInCooldown, cooldownRemaining, formatCooldown } from '../../hooks/use-follow-ups';
import { Badge } from '../ui/Badge';

interface Props {
  task: Task;
}

export function PingCooldownBadge({ task }: Props) {
  if (!task.pingedAt) return null;

  const inCooldown = isInCooldown(task);
  const remaining = cooldownRemaining(task);

  if (!inCooldown) {
    return <Badge color="orange">Ready to ping</Badge>;
  }

  return (
    <Badge color="zinc">{formatCooldown(remaining)} left</Badge>
  );
}
