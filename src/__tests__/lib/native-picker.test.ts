import { openNativePicker } from '../../lib/native-picker';

describe('openNativePicker', () => {
  it('calls showPicker when the element supports it', () => {
    const showPicker = vi.fn();
    openNativePicker({ showPicker } as unknown as HTMLInputElement);
    expect(showPicker).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when showPicker is unavailable', () => {
    expect(() => openNativePicker({} as unknown as HTMLInputElement)).not.toThrow();
  });

  it('swallows errors thrown by showPicker (e.g. no user activation)', () => {
    const showPicker = vi.fn(() => {
      throw new Error('not allowed');
    });
    expect(() => openNativePicker({ showPicker } as unknown as HTMLInputElement)).not.toThrow();
    expect(showPicker).toHaveBeenCalledTimes(1);
  });
});
