import { createTheme, responsiveFontSizes } from "@mui/material";


// 先建立统一主题，后续每个模块直接复用，避免样式分散。
export const appTheme = responsiveFontSizes(createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#0f766e",
    },
    secondary: {
      main: "#ca8a04",
    },
    background: {
      default: "#f8fbfd",
      paper: "#ffffff",
    },
    text: {
      primary: "#0f172a",
      secondary: "#475569",
    },
  },
  typography: {
    fontFamily: '"Space Grotesk", "Noto Sans SC", "Microsoft YaHei", sans-serif',
    h4: {
      fontWeight: 700,
      letterSpacing: "-0.02em",
    },
    h6: {
      fontWeight: 650,
    },
  },
  shape: {
    borderRadius: 14,
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backdropFilter: "blur(2px)",
        },
      },
    },
  },
}));
