"""Check real GPU computation before advertising a working decision service."""
import os

import torch


device = os.environ.get("LAYA_DEVICE", "cuda")
if device.startswith("cuda"):
    if not torch.cuda.is_available():
        raise RuntimeError("Laya requested CUDA but no CUDA device is available")
    print(
        f"CUDA startup check: torch={torch.__version__}, runtime={torch.version.cuda}, "
        f"gpu={torch.cuda.get_device_name(device)}, "
        f"capability={torch.cuda.get_device_capability(device)}, "
        f"compiled_arches={torch.cuda.get_arch_list()}",
        flush=True,
    )
    # is_available() and allocation alone do not prove executable kernels exist.
    indices = torch.arange(16, device=device)
    matrix = torch.ones((16, 16), device=device, dtype=torch.float16)
    product = matrix @ matrix
    torch.cuda.synchronize(device)
    if indices[-1].item() != 15 or product[0, 0].item() != 16:
        raise RuntimeError("CUDA startup computation returned an invalid result")
    print("CUDA startup computation passed", flush=True)

os.execvp("laya-serve", ["laya-serve"])
