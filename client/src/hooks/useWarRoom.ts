/// <reference types="vite/client" />
import { useContext } from 'react';
import { WarRoomContext } from '../context/warRoomContextInstance';
import type { Article, WarRoomContextValue } from '../context/warRoomContextInstance';

export type { Article, WarRoomContextValue };

export function useWarRoom(): WarRoomContextValue {
  const context = useContext(WarRoomContext);
  if (!context) {
    throw new Error('useWarRoom must be used within a WarRoomProvider');
  }
  return context;
}
