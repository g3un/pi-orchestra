export interface BusMessage {
  id: string;
  message: string;
  from: string;
}

export interface Bus {
  id: string;
  name: string;
  messages: BusMessage[];
}
